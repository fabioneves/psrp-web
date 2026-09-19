using System.Threading.Channels;
using System.Buffers.Binary;
using Concentus;
using RemotePlay.Models.PlayStation;
using RemotePlay.Services.Streaming.Protocol;

namespace RemotePlay.Services.Software;

/// <param name="Key">The unit starts or is a keyframe: the only place video may move to another transport.</param>
public sealed record VideoUnit(byte[] Data, double Ready, bool Key = false);

public sealed class SoftwareReceiver(int videoQueueCapacity = 8, string videoCodec = "h264") : IAVReceiver, IDisposable
{
    private readonly Channel<VideoUnit> packets = Channel.CreateBounded<VideoUnit>(new BoundedChannelOptions(videoQueueCapacity)
    {
        FullMode = BoundedChannelFullMode.Wait,
        SingleReader = true
    });
    private readonly object sync = new();
    private readonly object audioSync = new();
    private readonly Channel<byte[]> audioPackets = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(32)
    {
        FullMode = BoundedChannelFullMode.DropOldest,
        SingleReader = true
    });
    private IOpusDecoder? opus;
    private float[] pcmSamples = [];
    private int audioRate = 48000, audioChannels = 2;
    public ChannelReader<byte[]> AudioPackets => audioPackets.Reader;
    private byte[] header = [];
    private bool waitingForIdr = true;
    private long framesReceived;
    public ChannelReader<VideoUnit> Packets => packets.Reader;
    /// <summary>Complete video frames the console delivered, before any keyframe gating; tells console output rate apart from browser presentation.</summary>
    public long FramesReceived => Interlocked.Read(ref framesReceived);

    public void OnStreamInfo(byte[] videoHeader, byte[] audioHeader)
    {
        lock (sync)
        {
            header = videoHeader.ToArray();
            waitingForIdr = true;
        }
        if (audioHeader.Length >= 10)
        {
            var rate = BinaryPrimitives.ReadInt32BigEndian(audioHeader.AsSpan(2, 4));
            var channels = audioHeader[0];
            if (channels is < 1 or > 2 || rate is not (8000 or 12000 or 16000 or 24000 or 48000))
                throw new IOException("Unsupported console audio format.");
            lock (audioSync)
            {
                opus?.Dispose();
                audioRate = rate; audioChannels = channels;
                pcmSamples = new float[rate * 120 / 1000 * channels];
                opus = OpusCodecFactory.CreateDecoder(rate, channels);
            }
        }
    }

    public void OnVideoPacket(byte[] packet)
    {
        lock (sync)
        {
            if (packet.Length <= 1 || packet[0] != 2) return;
            Interlocked.Increment(ref framesReceived);
            if (packet.Length > 2 * 1024 * 1024)
            {
                packets.Writer.TryComplete(new IOException("Console frame exceeds the 2 MiB limit."));
                return;
            }
            var key = ContainsIdr(packet, videoCodec);
            if (waitingForIdr)
            {
                if (!key) return;
                if (header.Length > 0) Write(header, true);
                waitingForIdr = false;
            }
            Write(packet.AsSpan(1).ToArray(), key);
        }
    }

    private void Write(byte[] packet, bool key)
    {
        if (!packets.Writer.TryWrite(new VideoUnit(packet, MediaPacket.Now, key)))
            packets.Writer.TryComplete(new IOException("Video delivery cannot keep up. Reconnect or lower the bitrate."));
    }

    public static bool ContainsIdr(ReadOnlySpan<byte> packet, string codec = "h264")
    {
        for (var i = 0; i + 3 < packet.Length; i++)
            if (packet[i] == 0 && packet[i + 1] == 0 && packet[i + 2] == 1)
            {
                var nal = packet[i + 3];
                if (codec == "hevc" ? i + 4 < packet.Length && ((nal >> 1) & 63) is >= 16 and <= 21 : (nal & 31) == 5)
                    return true;
            }
        return false;
    }

    public void EnterWaitForIdr() { lock (sync) waitingForIdr = true; }
    public void SetVideoCodec(string codec)
    {
        var normalized = codec.ToLowerInvariant() switch { "avc" => "h264", "h265" => "hevc", var value => value };
        if (normalized != videoCodec)
            packets.Writer.TryComplete(new IOException("The console supplied a different video codec than requested."));
    }
    public void OnAudioPacket(byte[] packet)
    {
        if (packet.Length <= 1 || packet[0] != (byte)HeaderType.AUDIO || packet.Length > 65536) return;
        lock (audioSync)
        {
            if (opus == null) return;
            var count = opus.Decode(packet.AsSpan(1), pcmSamples.AsSpan(), pcmSamples.Length / audioChannels, false);
            if (count > 0) audioPackets.Writer.TryWrite(TimedPcmPacket(pcmSamples.AsSpan(0, count * audioChannels), audioRate, audioChannels));
        }
    }

    public static byte[] TimedPcmPacket(ReadOnlySpan<float> samples, int rate, int channels)
    {
        var ready = MediaPacket.Now;
        return MediaPacket.Wrap(PcmPacket(samples, rate, channels), MediaPacket.Audio, ready,
            ready - samples.Length * 1000.0 / (rate * channels));
    }

    public static byte[] PcmPacket(ReadOnlySpan<float> samples, int rate, int channels)
    {
        var result = new byte[12 + samples.Length * 2];
        "PCM1"u8.CopyTo(result);
        BinaryPrimitives.WriteInt32LittleEndian(result.AsSpan(4), rate);
        BinaryPrimitives.WriteInt32LittleEndian(result.AsSpan(8), channels);
        for (var i = 0; i < samples.Length; i++)
            BinaryPrimitives.WriteInt16LittleEndian(result.AsSpan(12 + i * 2), (short)(Math.Clamp(samples[i], -1, 1) * 32767));
        return result;
    }

    public void SetAudioCodec(string codec)
    {
        if (!string.Equals(codec, "opus", StringComparison.OrdinalIgnoreCase))
            audioPackets.Writer.TryComplete(new IOException("The console must supply Opus audio."));
    }
    public void Dispose()
    {
        packets.Writer.TryComplete();
        audioPackets.Writer.TryComplete();
        lock (audioSync) { opus?.Dispose(); opus = null; }
    }
}
