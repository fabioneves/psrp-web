namespace RemotePlay.Services.Software;

public sealed class AccessUnitSplitter(string videoCodec)
{
    private readonly bool hevc = videoCodec is "h265" or "hevc";
    private byte[] buffer = new byte[65536];
    private int length, scanned;

    public List<byte[]> Push(ReadOnlySpan<byte> bytes)
    {
        if (length + bytes.Length > 2 * 1024 * 1024) throw new IOException("Video access unit exceeds the 2 MiB limit.");
        if (length + bytes.Length > buffer.Length) Array.Resize(ref buffer, Math.Max(buffer.Length * 2, length + bytes.Length));
        bytes.CopyTo(buffer.AsSpan(length));
        length += bytes.Length;
        var units = new List<byte[]>();
        var start = 0;
        for (var i = scanned; i + 3 < length; i++)
        {
            if (buffer[i] != 0 || buffer[i + 1] != 0 || buffer[i + 2] != 1 || !IsDelimiter(buffer[i + 3])) continue;
            var boundary = i > 0 && buffer[i - 1] == 0 ? i - 1 : i;
            if (boundary > start) units.Add(buffer.AsSpan(start, boundary - start).ToArray());
            start = boundary;
            i += 3;
        }
        if (start > 0)
        {
            Buffer.BlockCopy(buffer, start, buffer, 0, length - start);
            length -= start;
        }
        scanned = Math.Max(0, length - 3);
        return units;
    }

    public byte[]? Flush()
    {
        if (length == 0) return null;
        var unit = buffer.AsSpan(0, length).ToArray();
        length = scanned = 0;
        return unit;
    }

    private bool IsDelimiter(byte header) => hevc ? ((header >> 1) & 63) == 35 : (header & 31) == 9;

    public static async Task PumpAsync(Stream source, SoftwareReceiver receiver, string videoCodec, CancellationToken ct)
    {
        var splitter = new AccessUnitSplitter(videoCodec);
        var chunk = new byte[65536];
        int count;
        while ((count = await source.ReadAsync(chunk, ct)) > 0)
            foreach (var unit in splitter.Push(chunk.AsSpan(0, count)))
                receiver.OnVideoPacket([2, .. unit]);
        if (splitter.Flush() is { } last) receiver.OnVideoPacket([2, .. last]);
    }
}
