namespace RemotePlay.Services.Software;

/// <summary>The server end of the browser's unreliable video channel: answers one offer completely, then sends access units as fragments.</summary>
public sealed class RtcVideoChannel(ushort port, IReadOnlyList<string> advertised) : IDisposable
{
    private readonly RtcPeer peer = new(port);

    public Task Opened => peer.Opened;
    public Task Closed => peer.Closed;
    public bool IsOpen => peer.IsOpen;
    public int BufferedAmount => peer.BufferedAmount;

    public async Task<string> AnswerAsync(string offer, CancellationToken ct)
    {
        peer.SetRemoteDescription(offer, "offer");
        return Advertise(await peer.LocalDescriptionAsync(ct), advertised, port);
    }

    public bool Send(uint frameId, ReadOnlyMemory<byte> packet)
    {
        foreach (var fragment in FrameFragmenter.Split(frameId, packet))
            if (!peer.Send(fragment)) return false;
        return true;
    }

    /// <summary>Adds addresses the library cannot discover, such as a router's public one, as host candidates on the fixed port.</summary>
    public static string Advertise(string sdp, IReadOnlyList<string> addresses, ushort port)
    {
        if (addresses.Count == 0) return sdp;
        var lines = sdp.Split("\r\n").ToList();
        var last = lines.FindLastIndex(line => line.StartsWith("a=candidate:"));
        var end = lines.FindIndex(line => line.StartsWith("a=end-of-candidates"));
        var at = last >= 0 ? last + 1 : end >= 0 ? end : Math.Max(0, lines.Count - 1);
        lines.InsertRange(at, addresses.Select((address, index) => $"a=candidate:{91 + index} 1 UDP {2122317566 - index} {address} {port} typ host"));
        return string.Join("\r\n", lines);
    }

    public void Dispose() => peer.Dispose();
}

/// <summary>Where the WebRTC video channel listens and which addresses it tells the browser to try besides the ones the library finds.</summary>
public sealed record RtcOptions(ushort Port, IReadOnlyList<string> Advertise)
{
    public const ushort DefaultPort = 8443;

    public static RtcOptions FromEnvironment() => Parse(Environment.GetEnvironmentVariable("WEBRTC_PORT"),
        Environment.GetEnvironmentVariable("WEBRTC_PUBLIC_ADDRESS"), Environment.GetEnvironmentVariable("REMOTE_PLAY_DOMAIN"));

    public static RtcOptions Parse(string? port, string? addresses, string? domain)
    {
        var names = (string.IsNullOrWhiteSpace(addresses) ? domain ?? "" : addresses)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return new(ushort.TryParse(port, out var parsed) && parsed > 0 ? parsed : DefaultPort, names);
    }

    /// <summary>Candidates carry addresses, so names are looked up for every offer: a home connection's public address changes.</summary>
    public async Task<IReadOnlyList<string>> ResolveAsync(CancellationToken ct)
    {
        var resolved = new List<string>();
        foreach (var name in Advertise)
        {
            if (System.Net.IPAddress.TryParse(name, out _)) { resolved.Add(name); continue; }
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(2));
                resolved.AddRange((await System.Net.Dns.GetHostAddressesAsync(name, timeout.Token)).Select(address => address.ToString()));
            }
            catch (Exception ex) when (ex is System.Net.Sockets.SocketException or OperationCanceledException && !ct.IsCancellationRequested) { }
        }
        return resolved.Distinct().ToList();
    }
}

public enum VideoRoute { WebSocket, DataChannel, Skip }

/// <summary>Decides, unit by unit, which transport carries video. Transport only changes at a keyframe, because frames sent on the
/// data channel may never have arrived and a delta frame that follows them cannot be decoded.</summary>
public sealed class VideoTransportSwitch
{
    private bool onChannel, failed;
    /// <summary>Video is being withheld until a keyframe; the caller asks the console for one.</summary>
    public bool NeedsKeyframe { get; private set; }

    public void SendFailed() => failed = true;

    /// <returns>The route for this unit, and the transport to announce to the browser when it just changed.</returns>
    public (VideoRoute Route, string? Announce) Next(bool key, bool channelOpen)
    {
        string? announce = null;
        if (onChannel && (!channelOpen || failed)) { onChannel = false; NeedsKeyframe = true; announce = "websocket"; }
        if (!channelOpen) failed = false;
        if (!onChannel && channelOpen && !failed && key) { onChannel = true; NeedsKeyframe = false; return (VideoRoute.DataChannel, "webrtc"); }
        if (onChannel) return (VideoRoute.DataChannel, null);
        if (NeedsKeyframe && !key) return (VideoRoute.Skip, announce);
        NeedsKeyframe = false;
        return (VideoRoute.WebSocket, announce);
    }
}

/// <summary>A session's WebRTC side: turns the browser's offer into an open channel, answering on the stream's WebSocket.</summary>
public sealed class RtcVideoLink(RtcOptions options, ILogger logger) : IDisposable
{
    private readonly object sync = new();
    private RtcVideoChannel? channel;
    private bool disposed;
    public RtcVideoChannel? Channel { get { lock (sync) return channel; } }

    public async Task AnswerAsync(string offer, System.Net.WebSockets.WebSocket socket, SemaphoreSlim sendGate, CancellationToken ct)
    {
        object reply;
        RtcVideoChannel? created = null;
        try
        {
            if (!RtcPeer.Available) throw new IOException("This server was built without WebRTC support.");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            created = new RtcVideoChannel(options.Port, await options.ResolveAsync(timeout.Token));
            reply = new { type = "rtc-answer", sdp = await created.AnswerAsync(offer, timeout.Token) };
            RtcVideoChannel? previous;
            lock (sync)
            {
                if (disposed) { created.Dispose(); return; }
                previous = channel; channel = created; created = null;
            }
            previous?.Dispose();
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            created?.Dispose();
            // The offer itself stays out of the log: it names the browser's addresses and its ICE credentials.
            logger.LogWarning("WebRTC offer could not be answered: {Reason}", ex.Message);
            reply = new { type = "transport", transport = "websocket", reason = ex is OperationCanceledException ? "The server could not prepare a WebRTC answer in time." : ex.Message };
        }
        try
        {
            await sendGate.WaitAsync(ct);
            try { await socket.SendAsync(System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(reply), System.Net.WebSockets.WebSocketMessageType.Text, true, ct); }
            finally { sendGate.Release(); }
        }
        catch (Exception ex) when (ex is System.Net.WebSockets.WebSocketException or OperationCanceledException or ObjectDisposedException) { }
    }

    public void Dispose()
    {
        RtcVideoChannel? last;
        lock (sync) { disposed = true; last = channel; channel = null; }
        last?.Dispose();
    }
}
