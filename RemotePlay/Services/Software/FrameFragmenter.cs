using System.Buffers.Binary;

namespace RemotePlay.Services.Software;

/// <summary>Splits one access unit into data-channel messages: uint32 frameId, uint16 index, uint16 count (little-endian), then payload.</summary>
public static class FrameFragmenter
{
    // Small enough that a fragment plus SCTP, DTLS and UDP headers stays under a 1280-byte path, so one lost datagram costs one fragment.
    public const int MaxPayload = 1100, HeaderSize = 8;

    public static IEnumerable<byte[]> Split(uint frameId, ReadOnlyMemory<byte> packet)
    {
        var count = (packet.Length + MaxPayload - 1) / MaxPayload;
        if (count is 0 or > ushort.MaxValue) throw new ArgumentException($"An access unit of {packet.Length} bytes cannot be fragmented.", nameof(packet));
        return Fragments(frameId, packet, count);
    }

    private static IEnumerable<byte[]> Fragments(uint frameId, ReadOnlyMemory<byte> packet, int count)
    {
        for (var index = 0; index < count; index++)
        {
            var payload = packet.Slice(index * MaxPayload, Math.Min(MaxPayload, packet.Length - index * MaxPayload));
            var fragment = new byte[HeaderSize + payload.Length];
            BinaryPrimitives.WriteUInt32LittleEndian(fragment, frameId);
            BinaryPrimitives.WriteUInt16LittleEndian(fragment.AsSpan(4), (ushort)index);
            BinaryPrimitives.WriteUInt16LittleEndian(fragment.AsSpan(6), (ushort)count);
            payload.Span.CopyTo(fragment.AsSpan(HeaderSize));
            yield return fragment;
        }
    }
}
