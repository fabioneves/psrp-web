using System.Threading.Channels;
using RemotePlay.Models.PlayStation;

namespace RemotePlay.Services.Software;

public sealed class SoftwareReceiver : IAVReceiver, IDisposable
{
    private readonly Channel<byte[]> packets = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(8)
    {
        FullMode = BoundedChannelFullMode.Wait,
        SingleReader = true
    });
    private readonly object sync = new();
    private byte[] header = [];
    private bool waitingForIdr = true;
    public ChannelReader<byte[]> Packets => packets.Reader;

    public void OnStreamInfo(byte[] videoHeader, byte[] audioHeader)
    {
        lock (sync)
        {
            header = videoHeader.ToArray();
            waitingForIdr = true;
        }
    }

    public void OnVideoPacket(byte[] packet)
    {
        lock (sync)
        {
            if (packet.Length <= 1 || packet[0] != 2) return;
            if (packet.Length > 2 * 1024 * 1024)
            {
                packets.Writer.TryComplete(new IOException("Console frame exceeds the 2 MiB limit."));
                return;
            }
            if (waitingForIdr)
            {
                if (!ContainsIdr(packet)) return;
                if (header.Length > 0) Write(header);
                waitingForIdr = false;
            }
            Write(packet.AsSpan(1).ToArray());
        }
    }

    private void Write(byte[] packet)
    {
        if (!packets.Writer.TryWrite(packet))
            packets.Writer.TryComplete(new IOException("Software encoder cannot keep up. Reconnect or lower the bitrate."));
    }

    public static bool ContainsIdr(ReadOnlySpan<byte> packet)
    {
        for (var i = 0; i + 3 < packet.Length; i++)
            if (packet[i] == 0 && packet[i + 1] == 0 && packet[i + 2] == 1 && (packet[i + 3] & 31) == 5)
                return true;
        return false;
    }

    public void EnterWaitForIdr() { lock (sync) waitingForIdr = true; }
    public void SetVideoCodec(string codec)
    {
        if (!string.Equals(codec, "h264", StringComparison.OrdinalIgnoreCase) && !string.Equals(codec, "avc", StringComparison.OrdinalIgnoreCase))
            packets.Writer.TryComplete(new IOException("The console must supply H.264 for software streaming."));
    }
    public void OnAudioPacket(byte[] packet) { }
    public void SetAudioCodec(string codec) { }
    public void Dispose() => packets.Writer.TryComplete();
}
