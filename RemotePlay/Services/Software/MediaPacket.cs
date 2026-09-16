using System.Buffers.Binary;

namespace RemotePlay.Services.Software;

public static class MediaPacket
{
    public const int HeaderSize = 32;
    public const int TransportStream = 1, Audio = 2, VideoUnit = 3;
    public static double Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public static byte[] Wrap(ReadOnlySpan<byte> payload, int kind, double ready, double mediaTime)
    {
        var packet = new byte[HeaderSize + payload.Length];
        payload.CopyTo(packet.AsSpan(HeaderSize));
        Stamp(packet, kind, ready, mediaTime);
        return packet;
    }

    public static void Stamp(Span<byte> packet, int kind, double ready, double mediaTime)
    {
        "RPM1"u8.CopyTo(packet);
        BinaryPrimitives.WriteInt32LittleEndian(packet[4..], kind);
        BinaryPrimitives.WriteDoubleLittleEndian(packet[8..], ready);
        BinaryPrimitives.WriteDoubleLittleEndian(packet[24..], mediaTime);
        MarkSent(packet);
    }

    public static void MarkSent(Span<byte> packet) => BinaryPrimitives.WriteDoubleLittleEndian(packet[16..], Now);
}
