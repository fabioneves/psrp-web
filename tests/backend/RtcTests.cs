using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
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

    // Two libdatachannel peers in this process: the client stands in for the browser, the server side is the product's.
    public static async Task RunPeersAsync(Action<bool, string> check)
    {
        const string answerSdp = "v=0\r\na=candidate:1 1 UDP 2122317823 10.0.0.5 8443 typ host\r\na=end-of-candidates\r\n";
        var advertised = RtcVideoChannel.Advertise(answerSdp, ["203.0.113.7", "2001:db8::7"], 8443);
        check(advertised.Contains("10.0.0.5 8443 typ host\r\na=candidate:91 1 UDP 2122317566 203.0.113.7 8443 typ host\r\na=candidate:92 1 UDP 2122317565 2001:db8::7 8443 typ host\r\na=end-of-candidates"),
            "advertised public addresses join the answer as host candidates on the fixed port, after the gathered ones");
        check(RtcVideoChannel.Advertise(answerSdp, [], 8443) == answerSdp, "an answer with nothing to advertise is left alone");

        check(RtcPeer.Available, "libdatachannel loads in this image");
        if (!RtcPeer.Available) return;
        ushort port;
        using (var probe = new UdpClient(new IPEndPoint(IPAddress.Any, 0))) port = (ushort)((IPEndPoint)probe.Client.LocalEndPoint!).Port;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        using var server = new RtcVideoChannel(port, ["203.0.113.7"]);
        var client = new RtcPeer();
        try
        {
            var messages = System.Threading.Channels.Channel.CreateUnbounded<byte[]>();
            client.Message += message => messages.Writer.TryWrite(message);
            client.CreateChannel("video", unordered: true, maxRetransmits: 0);
            var answer = await server.AnswerAsync(await client.LocalDescriptionAsync(timeout.Token), timeout.Token);
            check(answer.Split("\r\n").Count(line => line.StartsWith("a=candidate:") && line.Contains($" {port} typ host")) >= 2 && answer.Contains($"203.0.113.7 {port} typ host"),
                "one offer gets a complete answer: every candidate on the fixed UDP port, the advertised address among them");
            client.SetRemoteDescription(answer, "answer");
            await server.Opened.WaitAsync(timeout.Token);
            check(server.IsOpen, "the browser's unreliable channel opens on the server without any candidate messages");

            var unit = new byte[150_000];
            new Random(5).NextBytes(unit);
            check(server.Send(7, unit), "a 150 KB keyframe is accepted by the open channel");
            var parts = new List<byte[]>();
            while (parts.Count == 0 || parts.Count < BinaryPrimitives.ReadUInt16LittleEndian(parts[0].AsSpan(6)))
                parts.Add(await messages.Reader.ReadAsync(timeout.Token));
            var rebuilt = parts.OrderBy(part => BinaryPrimitives.ReadUInt16LittleEndian(part.AsSpan(4))).SelectMany(part => part.Skip(FrameFragmenter.HeaderSize)).ToArray();
            check(parts.Count == 3 && parts.All(part => BinaryPrimitives.ReadUInt32LittleEndian(part) == 7) && rebuilt.AsSpan().SequenceEqual(unit),
                "the keyframe crosses the data channel as three messages and rebuilds byte for byte");
            for (var waited = 0; server.BufferedAmount > 0 && waited < 50; waited++) await Task.Delay(20, timeout.Token);
            check(server.BufferedAmount == 0, "nothing stays buffered once the peer has taken the frame");

            client.Dispose();
            await server.Closed.WaitAsync(TimeSpan.FromSeconds(10), timeout.Token);
            check(!server.IsOpen && !server.Send(8, unit), "the server notices the browser's channel going away, and sending then reports failure");
        }
        finally { client.Dispose(); }
    }
}
