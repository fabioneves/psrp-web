using System.Diagnostics;
using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using RemotePlay.Contracts.Services;
using RemotePlay.Models.Context;
using RemotePlay.Models.PlayStation;
using RemotePlay.Services.Streaming.Controller;

namespace RemotePlay.Services.Software;

public sealed class SoftwareSession(RPContext db, ISessionService sessions, IStreamingService streams,
    IControllerService controller, ILogger<SoftwareSession> logger)
{
    public async Task RunAsync(WebSocket socket, StreamTicket grant, CancellationToken aborted)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(aborted);
        var ct = lifetime.Token;
        Guid? sessionId = null;
        Process? generator = null;
        SoftwareTranscoder? transcoder = null;
        using var receiver = new SoftwareReceiver();
        Task[] workers = [];
        try
        {
            await SendStatus(socket, "Connecting", ct);
            transcoder = new SoftwareTranscoder(grant.BitrateKbps);
            Task feed;
            if (grant.Demo)
            {
                generator = SoftwareTranscoder.Start(["-hide_banner", "-loglevel", "error", "-re",
                    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=60", "-an", "-c:v", "libx264",
                    "-preset", "ultrafast", "-tune", "zerolatency", "-threads", "2", "-g", "60",
                    "-b:v", "8000k", "-pix_fmt", "yuv420p", "-f", "h264", "pipe:1"]);
                feed = transcoder.FeedAsync(generator.StandardOutput.BaseStream, ct);
            }
            else
            {
                var device = await db.UserDevices.Where(d => d.UserId == grant.UserId && d.IsActive &&
                    d.Device != null && d.Device.HostId == grant.HostId && d.Device.IsRegistered == true)
                    .Select(d => d.Device!).SingleAsync(ct);
                var session = await sessions.StartSessionAsync(device.IpAddress!, new DeviceCredentials
                {
                    HostId = device.HostId!, HostName = device.HostName!, HostIp = device.IpAddress!,
                    RegistrationKey = Convert.FromHexString(device.RegistKey!),
                    ServerKey = Convert.FromHexString(device.RPKey!)
                }, device.HostType!, new SessionStartOptions
                {
                    Resolution = "720p", Fps = "60", Bitrate = "10000", StreamType = "1",
                    AutoStartStream = false, AutoConnectController = false
                }, ct);
                sessionId = session.Id;
                if (!await sessions.WaitReadyAsync(session.Id, TimeSpan.FromSeconds(15), ct))
                    throw new IOException("PlayStation session did not become ready. Check Remote Play settings.");
                if (!await streams.StartStreamAsync(session.Id, false, ct))
                    throw new IOException("Could not start the console video stream.");
                await streams.AttachReceiverAsync(session.Id, receiver, ct);
                var stream = await streams.GetStreamAsync(session.Id);
                if (stream != null) await stream.RequestKeyframeAsync();
                if (!await controller.ConnectAsync(session.Id, ct) || !await controller.StartAsync(session.Id, ct))
                    throw new IOException("Could not start console input.");
                feed = transcoder.FeedAsync(receiver, ct);
            }
            await SendStatus(socket, grant.Demo ? "Test stream" : "Console connected", ct);
            workers = [feed, transcoder.SendAsync(socket, ct), ReceiveAsync(socket, sessionId, ct)];
            var completed = await Task.WhenAny(workers);
            await completed;
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !aborted.IsCancellationRequested)
        {
            logger.LogWarning("Software stream ended: {Reason}", ex.Message);
            if (socket.State == WebSocketState.Open)
            {
                lifetime.Cancel();
                if (workers.Length > 0) await ObserveWorkers(workers);
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                try { await SendStatus(socket, "Stream stopped. Check the console, network and server logs, then reconnect.", timeout.Token, true); }
                catch (WebSocketException) { }
                catch (OperationCanceledException) { }
            }
        }
        catch (OperationCanceledException) { }
        finally
        {
            await lifetime.CancelAsync();
            receiver.Dispose();
            transcoder?.Dispose();
            if (generator != null)
            {
                if (!generator.HasExited) generator.Kill(entireProcessTree: true);
                generator.WaitForExit(3000);
                generator.Dispose();
            }
            await ObserveWorkers(workers);
            if (sessionId is { } id)
            {
                await streams.StopStreamAsync(id);
                await sessions.StopSessionAsync(id);
            }
            if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                try { await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "Session ended", timeout.Token); }
                catch (WebSocketException) { }
                catch (OperationCanceledException) { }
            }
        }
    }

    private static async Task ObserveWorkers(Task[] workers)
    {
        try { await Task.WhenAll(workers); }
        catch (Exception) { }
    }

    private static Task SendStatus(WebSocket socket, string message, CancellationToken ct, bool error = false) =>
        socket.SendAsync(JsonSerializer.SerializeToUtf8Bytes(new { type = error ? "error" : "status", message }),
            WebSocketMessageType.Text, true, ct);

    private async Task ReceiveAsync(WebSocket socket, Guid? sessionId, CancellationToken ct)
    {
        var buffer = new byte[2048];
        var pressed = new HashSet<FeedbackEvent.ButtonType>();
        var lastHeartbeat = Stopwatch.StartNew();
        while (!ct.IsCancellationRequested)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(10));
            var result = await socket.ReceiveAsync(buffer.AsMemory(), timeout.Token);
            if (result.MessageType == WebSocketMessageType.Close) return;
            if (!result.EndOfMessage || result.MessageType != WebSocketMessageType.Text)
                throw new IOException("Invalid input message.");
            var input = JsonSerializer.Deserialize<InputMessage>(buffer.AsSpan(0, result.Count), JsonOptions)
                ?? throw new IOException("Empty input message.");
            if (input.Type == "ping") { lastHeartbeat.Restart(); continue; }
            if (lastHeartbeat.Elapsed > TimeSpan.FromSeconds(10)) throw new IOException("Browser heartbeat expired.");
            if (sessionId is not { } id) continue;
            switch (input.Type)
            {
                case "button" when Enum.TryParse<FeedbackEvent.ButtonType>(input.Button, out var button) && Enum.IsDefined(button):
                    if (input.Pressed ? pressed.Add(button) : pressed.Remove(button))
                    {
                        await controller.ButtonAsync(id, button, input.Pressed ? IControllerService.ButtonAction.PRESS : IControllerService.ButtonAction.RELEASE, ct: ct);
                        if (button == FeedbackEvent.ButtonType.L2) await controller.SetTriggersAsync(id, l2: input.Pressed ? 1 : 0, ct: ct);
                        if (button == FeedbackEvent.ButtonType.R2) await controller.SetTriggersAsync(id, r2: input.Pressed ? 1 : 0, ct: ct);
                    }
                    break;
                case "stick" when input.Stick is "left" or "right" && float.IsFinite(input.X) && float.IsFinite(input.Y):
                    await controller.StickAsync(id, input.Stick, point: (Math.Clamp(input.X, -1, 1), Math.Clamp(input.Y, -1, 1)), ct: ct);
                    break;
                case "reset":
                    foreach (var held in pressed) await controller.ButtonAsync(id, held, IControllerService.ButtonAction.RELEASE, ct: ct);
                    pressed.Clear();
                    await controller.StickAsync(id, "left", point: (0, 0), ct: ct);
                    await controller.StickAsync(id, "right", point: (0, 0), ct: ct);
                    await controller.SetTriggersAsync(id, 0, 0, ct);
                    break;
                default: throw new IOException("Unknown input command.");
            }
        }
    }

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };
    private sealed record InputMessage(string Type, string? Button, bool Pressed, string? Stick, float X, float Y);
}
