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
