using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
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

        var receiver = new SoftwareReceiver(8, "h264");
        receiver.OnStreamInfo([0, 0, 0, 1, 0x67, 1], []);
        receiver.OnVideoPacket([2, 0, 0, 0, 1, 0x65, 7]);
        receiver.OnVideoPacket([2, 0, 0, 0, 1, 0x41, 9]);
        check(receiver.Packets.TryRead(out var parameters) && parameters.Key && receiver.Packets.TryRead(out var idr) && idr.Key &&
            receiver.Packets.TryRead(out var delta) && !delta.Key, "the codec header and the IDR are marked as a place to switch transport; a delta frame is not");

        var route = new VideoTransportSwitch();
        check(route.Next(key: true, channelOpen: false) == (VideoRoute.WebSocket, null) && route.Next(false, true) == (VideoRoute.WebSocket, null),
            "video stays on the WebSocket until the data channel is open and a keyframe arrives");
        check(route.Next(true, true) == (VideoRoute.DataChannel, "webrtc") && route.Next(false, true) == (VideoRoute.DataChannel, null),
            "at the first keyframe after the channel opens video moves to it and says so once");
        check(route.Next(false, false) == (VideoRoute.Skip, "websocket") && route.NeedsKeyframe && route.Next(false, false) == (VideoRoute.Skip, null),
            "when the channel goes away the browser is told, a keyframe is wanted, and deltas that followed lost frames are withheld");
        check(route.Next(true, false) == (VideoRoute.WebSocket, null) && !route.NeedsKeyframe && route.Next(false, false) == (VideoRoute.WebSocket, null),
            "video resumes on the WebSocket at the next keyframe");
        check(route.Next(true, true) == (VideoRoute.DataChannel, "webrtc"), "a channel that opens again is used again from a keyframe");
        route.SendFailed();
        check(route.Next(false, true) == (VideoRoute.Skip, "websocket") && route.NeedsKeyframe, "a failed send is treated like a closed channel even while it still reads open");

        var options = RtcOptions.Parse("18444", " 203.0.113.7, play.example.test ,", "fallback.example.test");
        check(options.Port == 18444 && options.Advertise.SequenceEqual(new[] { "203.0.113.7", "play.example.test" }), "WEBRTC_PORT and WEBRTC_PUBLIC_ADDRESS are read; the domain is not needed when addresses are given");
        options = RtcOptions.Parse(null, null, "play.example.test");
        check(options.Port == 8443 && options.Advertise.SequenceEqual(new[] { "play.example.test" }), "without settings the port is 8443 and the public address comes from REMOTE_PLAY_DOMAIN");
        check(RtcOptions.Parse("70000", null, null).Port == 8443 && RtcOptions.Parse(null, null, null).Advertise.Count == 0, "an unusable port falls back to the default, and no domain means nothing is advertised");
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
        await RunSignalingAsync(check);
    }

    // The browser's offer arrives as an input message on the stream's WebSocket and the answer leaves on the same socket.
    private static async Task RunSignalingAsync(Action<bool, string> check)
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        using var browserConnection = new TcpClient();
        await browserConnection.ConnectAsync(IPAddress.Loopback, ((IPEndPoint)listener.LocalEndpoint).Port);
        using var serverConnection = await listener.AcceptTcpClientAsync();
        using var browserSocket = WebSocket.CreateFromStream(browserConnection.GetStream(), false, null, TimeSpan.Zero);
        using var serverSocket = WebSocket.CreateFromStream(serverConnection.GetStream(), true, null, TimeSpan.Zero);
        using var sendGate = new SemaphoreSlim(1, 1);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        ushort port;
        using (var probe = new UdpClient(new IPEndPoint(IPAddress.Any, 0))) port = (ushort)((IPEndPoint)probe.Client.LocalEndPoint!).Port;
        using var link = new RtcVideoLink(new RtcOptions(port, []), NullLogger.Instance);
        var router = new SoftwareInputRouter(null!, null, initializing: true)
        {
            RtcOffer = sdp => link.AnswerAsync(sdp, serverSocket, sendGate, timeout.Token)
        };
        var reading = router.ReceiveAsync(serverSocket, timeout.Token, true, sendGate);
        using var client = new RtcPeer();
        client.CreateChannel("video", unordered: true, maxRetransmits: 0);
        // Padding stands in for a browser with many network interfaces: the offer must not be limited to one small read.
        var offer = await client.LocalDescriptionAsync(timeout.Token) + string.Concat(Enumerable.Repeat("a=x-padding:0123456789012345678901234567890123456789\r\n", 60));
        await browserSocket.SendAsync(JsonSerializer.SerializeToUtf8Bytes(new { type = "rtc-offer", sdp = offer }), WebSocketMessageType.Text, true, timeout.Token);
        var buffer = new byte[16 * 1024];
        var reply = await browserSocket.ReceiveAsync(buffer, timeout.Token);
        using var message = JsonDocument.Parse(buffer.AsMemory(0, reply.Count));
        check(offer.Length > 3000 && message.RootElement.GetProperty("type").GetString() == "rtc-answer", "a 3 KB offer sent as an input message is answered on the same socket");
        client.SetRemoteDescription(message.RootElement.GetProperty("sdp").GetString()!, "answer");
        await link.Channel!.Opened.WaitAsync(timeout.Token);
        check(link.Channel.IsOpen, "the channel negotiated over the WebSocket opens");
        await browserSocket.SendAsync(Encoding.UTF8.GetBytes("{\"type\":\"rtc-offer\",\"sdp\":\"not sdp\"}"), WebSocketMessageType.Text, true, timeout.Token);
        reply = await browserSocket.ReceiveAsync(buffer, timeout.Token);
        using var refusal = JsonDocument.Parse(buffer.AsMemory(0, reply.Count));
        check(refusal.RootElement.GetProperty("type").GetString() == "transport" && refusal.RootElement.GetProperty("transport").GetString() == "websocket" &&
            refusal.RootElement.GetProperty("reason").GetString()!.Length > 0 && !reading.IsCompleted,
            "an offer the server cannot use is answered with the WebSocket transport and a reason, and the input reader carries on");
        timeout.Cancel();
        try { await reading; } catch (OperationCanceledException) { }
    }
}
