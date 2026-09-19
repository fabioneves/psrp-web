using System.Buffers.Binary;
using RemotePlay.Services.Software;

static class RtcTests
{
    public static void Run(Action<bool, string> check)
    {
        foreach (var length in new[] { 1, FrameFragmenter.MaxPayload, FrameFragmenter.MaxPayload + 1, FrameFragmenter.MaxPacketBytes })
        {
            var packet = new byte[length];
            new Random(length).NextBytes(packet);
            var fragments = FrameFragmenter.Split(7, packet).ToList();
            var expected = (length + FrameFragmenter.MaxPayload - 1) / FrameFragmenter.MaxPayload;
            var headers = fragments.Select((fragment, index) =>
                BinaryPrimitives.ReadUInt32LittleEndian(fragment) == 7 &&
                BinaryPrimitives.ReadUInt16LittleEndian(fragment.AsSpan(4)) == index &&
                BinaryPrimitives.ReadUInt16LittleEndian(fragment.AsSpan(6)) == expected);
            var rebuilt = fragments.SelectMany(fragment => fragment.Skip(FrameFragmenter.HeaderSize)).ToArray();
            check(fragments.Count == expected && headers.All(ok => ok) &&
                fragments.All(fragment => fragment.Length <= FrameFragmenter.HeaderSize + FrameFragmenter.MaxPayload) &&
                rebuilt.AsSpan().SequenceEqual(packet),
                $"a {length}-byte access unit survives fragmenting into {expected} data-channel messages");
        }
        check(FrameFragmenter.HeaderSize + FrameFragmenter.MaxPayload == 64 * 1024, "a data-channel message is 64 KiB at most, the size measured in the spike");
        var rejected = 0;
        foreach (var packet in new[] { Array.Empty<byte>(), new byte[FrameFragmenter.MaxPacketBytes + 1] })
            try { _ = FrameFragmenter.Split(1, packet).ToList(); } catch (ArgumentException) { rejected++; }
        check(rejected == 2, "an empty access unit and one larger than the browser accepts are rejected");

        var tickets = new StreamTickets(TimeProvider.System);
        check(tickets.Consume(tickets.Issue("alice", null, true, 10000, videoCodec: "h264"))?.Transport == "websocket", "a ticket that names no transport streams over the WebSocket");
        check(tickets.Consume(tickets.Issue("alice", null, true, 10000, videoCodec: "h265", transport: "webrtc"))?.Transport == "webrtc", "the chosen transport survives the single-use stream ticket");
        var refused = 0;
        foreach (var (codec, transport) in new[] { ("mpeg1", "webrtc"), ("h264", "quic") })
            try { tickets.Issue("alice", null, true, 10000, videoCodec: codec, transport: transport); } catch (ArgumentException) { refused++; }
        check(refused == 2, "WebRTC is refused for the MPEG-1 byte stream, and so is an unknown transport");
    }
}
