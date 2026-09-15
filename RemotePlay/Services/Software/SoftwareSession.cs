using System.Diagnostics;
using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using RemotePlay.Contracts.Services;
using RemotePlay.Models.Context;
using RemotePlay.Models.PlayStation;
using RemotePlay.Services.Streaming.Controller;
using RemotePlay.Services.Session;

namespace RemotePlay.Services.Software;

public sealed class SoftwareSession(RPContext db, ISessionService sessions, IStreamingService streams,
    IControllerService controller, ActiveSoftwareStreams active, ConsolePower power, ILogger<SoftwareSession> logger)
{
    public async Task RunAsync(WebSocket socket, StreamTicket grant, CancellationToken aborted)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(aborted);
        var ct = lifetime.Token;
        Guid? sessionId = null;
        Process? generator = null;
        SoftwareTranscoder? transcoder = null;
        using var receiver = new SoftwareReceiver(grant.VideoCodec == "h264" ? 32 : 8);
        using var sendGate = new SemaphoreSlim(1, 1);
        Task[] workers = [];
        ActiveSoftwareStream? published = null;
        try
        {
            await SendStatus(socket, "Connecting", ct);
            var profile = VideoProfile.Create(grant.Resolution, grant.Fps);
            transcoder = new SoftwareTranscoder(grant.BitrateKbps, grant.Resolution, grant.Fps, grant.VideoCodec);
            Task feed;
            if (grant.Demo)
            {
                generator = SoftwareTranscoder.Start(["-hide_banner", "-loglevel", "error", "-re",
                    "-f", "lavfi", "-i", $"testsrc2=size={profile.Width}x{profile.Height}:rate={profile.Fps}", "-an", "-c:v", "libx264",
                    "-preset", "ultrafast", "-tune", "zerolatency", "-threads", "2", "-g", "60",
                    "-b:v", "8000k", "-pix_fmt", "yuv420p", "-f", "h264", "pipe:1"]);
                feed = transcoder.FeedAsync(generator.StandardOutput.BaseStream, ct);
            }
            else
            {
                var device = await db.UserDevices.Where(d => d.UserId == grant.UserId && d.IsActive &&
                    d.Device != null && d.Device.HostId == grant.HostId && d.Device.IsRegistered == true)
                    .Select(d => d.Device!).SingleAsync(ct);
                await power.EnsureReadyAsync(device, message => SendStatus(socket, message, ct), ct);
                var session = await sessions.StartSessionAsync(device.IpAddress!, new DeviceCredentials
                {
                    HostId = device.HostId!, HostName = device.HostName!, HostIp = device.IpAddress!,
                    RegistrationKey = Convert.FromHexString(device.RegistKey!),
                    ServerKey = Convert.FromHexString(device.RPKey!)
                }, device.HostType!, new SessionStartOptions
                {
                    Resolution = grant.Resolution, Fps = grant.Fps.ToString(), Bitrate = Math.Min(grant.BitrateKbps, 15000).ToString(), StreamType = "1",
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
            var input = new SoftwareInputRouter(controller, sessionId);
            published = new ActiveSoftwareStream(grant, input, ct);
            active.Set(published);
            workers = [feed, transcoder.SendAsync(socket, ct, sendGate), input.ReceiveAsync(socket, ct, true, sendGate),
                SendAudioAsync(socket, receiver, grant.Demo, sendGate, ct)];
            var completed = await Task.WhenAny(workers);
            await completed;
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !aborted.IsCancellationRequested)
        {
            logger.LogWarning(ex, "Software stream ended: {Reason}", ex.Message);
            if (socket.State == WebSocketState.Open)
            {
                lifetime.Cancel();
                transcoder?.Dispose();
                transcoder = null;
                if (workers.Length > 0) await ObserveWorkers(workers);
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                try { await SendStatus(socket, ex is TimeoutException or ConsoleHandshakeException ? ex.Message : "Stream stopped. Check the console, network and server logs, then reconnect.", timeout.Token, true); }
                catch (WebSocketException) { }
                catch (OperationCanceledException) { }
            }
        }
        catch (OperationCanceledException) { }
        finally
        {
            await lifetime.CancelAsync();
            if (published != null) active.Remove(published);
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
                try { await streams.StopStreamAsync(id); }
                finally { await sessions.StopSessionAsync(id); }
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

    private static async Task SendAudioAsync(WebSocket socket, SoftwareReceiver receiver, bool demo,
        SemaphoreSlim sendGate, CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(20));
        long sample = 0;
        while (!ct.IsCancellationRequested)
        {
            byte[] packet;
            if (demo)
            {
                if (!await timer.WaitForNextTickAsync(ct)) return;
                var samples = new float[960 * 2];
                for (var i = 0; i < 960; i++, sample++)
                    samples[i * 2] = samples[i * 2 + 1] = (float)(0.1 * Math.Sin(sample * 2 * Math.PI * 440 / 48000));
                packet = SoftwareReceiver.TimedPcmPacket(samples, 48000, 2);
            }
            else packet = await receiver.AudioPackets.ReadAsync(ct);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(1));
            await sendGate.WaitAsync(timeout.Token);
            try
            {
                MediaPacket.MarkSent(packet);
                await socket.SendAsync(packet, WebSocketMessageType.Binary, true, timeout.Token);
            }
            finally { sendGate.Release(); }
        }
    }

}
