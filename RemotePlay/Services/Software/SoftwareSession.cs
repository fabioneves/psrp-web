using System.Diagnostics;
using System.Net.WebSockets;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using RemotePlay.Contracts.Services;
using RemotePlay.Models.Context;
using RemotePlay.Models.PlayStation;
using RemotePlay.Services.Streaming.Controller;
using RemotePlay.Services.Streaming.Core;
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
        RPStreamV2? stream = null;
        Process? generator = null;
        SoftwareTranscoder? transcoder = null;
        using var receiver = new SoftwareReceiver(grant.VideoCodec == "mpeg1" ? 8 : 32, grant.VideoCodec == "h265" ? "hevc" : "h264");
        using var sendGate = new SemaphoreSlim(1, 1);
        Task[] workers = [];
        var published = new ActiveSoftwareStream(grant, lifetime);
        published.Track(socket, sendGate);
        active.Set(published);
        var input = new SoftwareInputRouter(controller, null, initializing: true);
        async Task ReadInput()
        {
            try { await input.ReceiveAsync(socket, ct, true, sendGate); }
            finally { await lifetime.CancelAsync(); }
        }
        var inputTask = ReadInput();
        workers = [inputTask];
        try
        {
            await SendStatus(socket, "Connecting", ct, sendGate: sendGate);
            var profile = VideoProfile.Create(grant.Resolution, grant.Fps);
            var native = grant.VideoCodec != "mpeg1";
            transcoder = native ? null : new SoftwareTranscoder(grant.BitrateKbps, grant.Resolution, grant.Fps);
            Task? feed = null;
            if (grant.Demo)
            {
                var encoderOptions = grant.VideoCodec == "h265"
                    ? new[] { "-c:v", "libx265", "-x265-params", "pools=1:frame-threads=1:log-level=error:repeat-headers=1:aud=1" }
                    : new[] { "-c:v", "libx264", "-x264-params", "aud=1" };
                generator = SoftwareTranscoder.Start(["-hide_banner", "-loglevel", "error", "-re",
                    "-f", "lavfi", "-i", $"testsrc2=size={profile.Width}x{profile.Height}:rate={profile.Fps}", "-an", .. encoderOptions,
                    "-preset", "ultrafast", "-tune", "zerolatency", "-threads", "2", "-g", "60",
                    "-b:v", "8000k", "-pix_fmt", "yuv420p", "-f", grant.VideoCodec == "h265" ? "hevc" : "h264", "pipe:1"]);
                feed = native ? AccessUnitSplitter.PumpAsync(generator.StandardOutput.BaseStream, receiver, grant.VideoCodec, ct)
                    : transcoder!.FeedAsync(generator.StandardOutput.BaseStream, ct);
            }
            else
            {
                var device = await db.UserDevices.Where(d => d.UserId == grant.UserId && d.IsActive &&
                    d.Device != null && d.Device.HostId == grant.HostId && d.Device.IsRegistered == true)
                    .Select(d => d.Device!).SingleAsync(ct);
                await power.EnsureReadyAsync(device, message => SendStatus(socket, message, ct, sendGate: sendGate), ct);
                var session = await sessions.StartSessionAsync(device.IpAddress!, new DeviceCredentials
                {
                    HostId = device.HostId!, HostName = device.HostName!, HostIp = device.IpAddress!,
                    RegistrationKey = Convert.FromHexString(device.RegistKey!),
                    ServerKey = Convert.FromHexString(device.RPKey!)
                }, device.HostType!, new SessionStartOptions
                {
                    Resolution = grant.Resolution, Fps = grant.Fps.ToString(), Bitrate = Math.Min(grant.BitrateKbps, 15000).ToString(), StreamType = grant.VideoCodec == "h265" ? "2" : "1",
                    AutoStartStream = false, AutoConnectController = false
                }, ct);
                sessionId = session.Id;
                if (!await sessions.WaitReadyAsync(session.Id, TimeSpan.FromSeconds(15), ct))
                    throw new IOException("PlayStation session did not become ready. Check Remote Play settings.");
                if (!await streams.StartStreamAsync(session.Id, false, ct))
                    throw new IOException("Could not start the console video stream.");
                await streams.AttachReceiverAsync(session.Id, receiver, ct);
                stream = await streams.GetStreamAsync(session.Id);
                if (stream != null) { stream.PeriodicIdrInterval = null; await stream.RequestKeyframeAsync(); }
                var console = stream;
                input.RequestKeyframe = () => { receiver.EnterWaitForIdr(); return console?.RequestKeyframeAsync() ?? Task.CompletedTask; };
                if (!await controller.ConnectAsync(session.Id, ct) || !await controller.StartAsync(session.Id, ct))
                    throw new IOException("Could not start console input.");
                if (!native) feed = transcoder!.FeedAsync(receiver, ct);
            }
            await SendStatus(socket, grant.Demo ? "Test stream" : "Console connected", ct, sendGate: sendGate);
            await input.BindSessionAsync(sessionId, ct);
            published.Input = input;
            var sendVideo = native ? SendVideoAsync(socket, receiver, sendGate, ct) : transcoder!.SendAsync(socket, ct, sendGate);
            var sendAudio = SendAudioAsync(socket, receiver, grant.Demo, sendGate, ct);
            if (stream != null) { _ = SendConsoleStatsAsync(socket, stream, sendGate, ct); _ = SendRumbleAsync(socket, stream, sendGate, ct); }
            workers = feed is null ? [sendVideo, sendAudio, inputTask] : [feed, sendVideo, sendAudio, inputTask];
            var completed = await Task.WhenAny(workers);
            await completed;
        }
        catch (Exception) when (published.StopRequested) { }
        catch (Exception ex) when (ex is not OperationCanceledException || !aborted.IsCancellationRequested)
        {
            logger.LogWarning(ex, "Software stream ended: {Reason}", ex.Message);
            if (socket.State == WebSocketState.Open)
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                try { await SendStatus(socket, ex is TimeoutException or ConsoleHandshakeException ? ex.Message : "Stream stopped. Check the console, network and server logs, then reconnect.", timeout.Token, true, sendGate); }
                catch (WebSocketException) { }
                catch (OperationCanceledException) { }
            }
        }
        catch (OperationCanceledException) { }
        finally
        {
            try
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
                    try { await streams.StopStreamAsync(id); }
                    finally { await sessions.StopSessionAsync(id); }
                }
                if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
                {
                    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    try { await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, published.StopRequested ? ActiveSoftwareStream.StopReason : "Session ended", timeout.Token); }
                    catch (WebSocketException) { }
                    catch (OperationCanceledException) { }
                }
            }
            finally { active.Remove(published); published.Complete(); }
        }
    }

    private static async Task ObserveWorkers(Task[] workers)
    {
        try { await Task.WhenAll(workers); }
        catch (Exception) { }
    }

    private static async Task SendStatus(WebSocket socket, string message, CancellationToken ct, bool error = false, SemaphoreSlim? sendGate = null)
    {
        if (sendGate != null) await sendGate.WaitAsync(ct);
        try
        {
            await socket.SendAsync(JsonSerializer.SerializeToUtf8Bytes(new { type = error ? "error" : "status", message }),
                WebSocketMessageType.Text, true, ct);
        }
        finally { sendGate?.Release(); }
    }

    private async Task SendRumbleAsync(WebSocket socket, RPStreamV2 stream, SemaphoreSlim sendGate, CancellationToken ct)
    {
        var latest = Channel.CreateBounded<(byte Left, byte Right)>(new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true });
        void OnRumble(object? sender, RumbleEventArgs e) => latest.Writer.TryWrite((e.AdjustedLeft, e.AdjustedRight));
        stream.RumbleReceived += OnRumble;
        try
        {
            (byte Left, byte Right) sent = (0, 0);
            await foreach (var rumble in latest.Reader.ReadAllAsync(ct))
            {
                if (rumble == sent) continue;
                sent = rumble;
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(1));
                await sendGate.WaitAsync(timeout.Token);
                try { await socket.SendAsync(JsonSerializer.SerializeToUtf8Bytes(new { type = "rumble", left = rumble.Left, right = rumble.Right }), WebSocketMessageType.Text, true, timeout.Token); }
                finally { sendGate.Release(); }
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { logger.LogDebug(ex, "Rumble relay stopped"); }
        finally { stream.RumbleReceived -= OnRumble; }
    }

    private async Task SendConsoleStatsAsync(WebSocket socket, RPStreamV2 stream, SemaphoreSlim sendGate, CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        object? last = null;
        try
        {
            while (await timer.WaitForNextTickAsync(ct))
            {
                var (snapshot, pipeline) = stream.GetStreamHealth();
                last = new { type = "console-stats", lost = pipeline.VideoLost, timeoutDropped = pipeline.VideoTimeoutDropped,
                    dropped = snapshot.TotalDroppedFrames, recovered = snapshot.TotalRecoveredFrames, frozen = snapshot.TotalFrozenFrames,
                    idr = pipeline.TotalIdrRequests, fecFailures = pipeline.FecFailures, pending = pipeline.PendingPackets,
                    consoleFps = Math.Round(snapshot.RecentFps, 1), consoleMbps = Math.Round(snapshot.MeasuredBitrateMbps, 1) };
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(1));
                await sendGate.WaitAsync(timeout.Token);
                try { await socket.SendAsync(JsonSerializer.SerializeToUtf8Bytes(last), WebSocketMessageType.Text, true, timeout.Token); }
                finally { sendGate.Release(); }
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { logger.LogDebug(ex, "Console statistics stopped"); }
        finally { if (last != null) logger.LogInformation("Console stream summary {Summary}", JsonSerializer.Serialize(last)); }
    }

    private static async Task SendVideoAsync(WebSocket socket, SoftwareReceiver receiver, SemaphoreSlim sendGate, CancellationToken ct)
    {
        await foreach (var unit in receiver.Packets.ReadAllAsync(ct))
        {
            var packet = MediaPacket.Wrap(unit.Data, MediaPacket.AccessUnit, unit.Ready, unit.Ready);
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
