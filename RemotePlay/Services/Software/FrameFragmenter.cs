using System.Buffers.Binary;

namespace RemotePlay.Services.Software;

/// <summary>Splits one access unit into data-channel messages: uint32 frameId, uint16 index, uint16 count (little-endian), then payload.</summary>
public static class FrameFragmenter
{
    // With no retransmission a frame missing any part is abandoned whole, so small fragments save nothing and cost the browser
    // one event each. A 64 KiB message carries a delta frame in one piece; SCTP splits it into datagrams itself.
    public const int HeaderSize = 8, MaxPayload = 64 * 1024 - HeaderSize;
    // The 2 MiB the receiver allows an access unit, plus its envelope; web/frame-reassembler.js refuses more.
    public const int MaxPacketBytes = 2 * 1024 * 1024 + MediaPacket.HeaderSize;

    public static IEnumerable<byte[]> Split(uint frameId, ReadOnlyMemory<byte> packet)
    {
        if (packet.Length is 0 or > MaxPacketBytes) throw new ArgumentException($"An access unit of {packet.Length} bytes cannot be fragmented.", nameof(packet));
        return Fragments(frameId, packet, (packet.Length + MaxPayload - 1) / MaxPayload);
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
