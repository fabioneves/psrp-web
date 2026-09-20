using System.Net;
using System.Buffers.Binary;
using System.Net.Sockets;
using System.Reflection;
using Microsoft.Extensions.Logging.Abstractions;
using RemotePlay.Models.PlayStation;
using RemotePlay.Services.Software;
using RemotePlay.Services.Streaming.Core;
using RemotePlay.Services.Streaming.Protocol;
using RemotePlay.Utils.Crypto;

static class StreamDisconnectTests
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        var payload = ProtoHandler.DisconnectPayload();
        check(ProtoCodec.TryParse(payload, out var message) && message.Type == RemotePlay.Protos.TakionMessage.Types.PayloadType.Disconnect && message.DisconnectPayload.Reason.Length > 0,
            "stream disconnect uses the console protobuf format");
        using var console = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
        using var stopped = new CancellationTokenSource();
        stopped.Cancel();
        var stream = new RPStreamV2(NullLogger<RPStreamV2>.Instance, NullLoggerFactory.Instance, new RemoteSession(), "127.0.0.1", ((IPEndPoint)console.Client.LocalEndPoint!).Port, stopped.Token);
        void Set(string name, object value) => typeof(RPStreamV2).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(stream, value);
        Set("_udpClient", new UdpClient(AddressFamily.InterNetwork));
        Set("_remoteEndPoint", console.Client.LocalEndPoint!);
        Set("_cipher", new StreamCipher(new byte[16], new byte[32]));
        var send = typeof(RPStreamV2).GetMethod("SendPacketInternalAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
        await (Task)send.Invoke(stream, [Packet.CreateData(5, 1, 1, new byte[] { 8, 1 }), 2, false])!;
        using var sentTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        await console.ReceiveAsync(sentTimeout.Token);
        Set("_tsn", 9u);
        await stream.StopAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        var packet = await console.ReceiveAsync(timeout.Token);
        check(BinaryPrimitives.ReadUInt32BigEndian(packet.Buffer.AsSpan(PacketConst.HeaderLength + 4)) == 6,
            "disconnect follows the last transmitted sequence even when cancelled queued messages reserved later numbers");
        check(packet.Buffer.AsSpan(packet.Buffer.Length - payload.Length).SequenceEqual(payload), "stopping a cancelled stream sends the disconnect before closing UDP");
        check(stream.DisconnectOutcome.StartsWith("sent twice, not acknowledged"), $"a console that never answers is reported as such: {stream.DisconnectOutcome}");

        // A console that acknowledges: the stop returns as soon as the acknowledgement for the disconnect's sequence arrives.
        using var polite = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
        var second = new RPStreamV2(NullLogger<RPStreamV2>.Instance, NullLoggerFactory.Instance, new RemoteSession(), "127.0.0.1", ((IPEndPoint)polite.Client.LocalEndPoint!).Port, stopped.Token);
        void SetSecond(string name, object value) => typeof(RPStreamV2).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(second, value);
        SetSecond("_udpClient", new UdpClient(new IPEndPoint(IPAddress.Loopback, 0)));
        SetSecond("_remoteEndPoint", polite.Client.LocalEndPoint!);
        SetSecond("_cipher", new StreamCipher(new byte[16], new byte[32]));
        SetSecond("_tsn", 41u);
        var answering = Task.Run(async () =>
        {
            var received = await polite.ReceiveAsync(timeout.Token);
            var tsn = BinaryPrimitives.ReadUInt32BigEndian(received.Buffer.AsSpan(PacketConst.HeaderLength + 4));
            await polite.SendAsync(Packet.CreateDataAck(tsn), received.RemoteEndPoint);
        });
        var watch = System.Diagnostics.Stopwatch.StartNew();
        await second.StopAsync();
        await answering;
        check(second.DisconnectOutcome.StartsWith("acknowledged") && watch.ElapsedMilliseconds < 300, $"an acknowledged disconnect ends the stop at once: {second.DisconnectOutcome}");

        // A browser that leaves while the console session is still starting: the stream is brought up anyway, because the
        // goodbye can only travel on it, and the console otherwise keeps the session "occupied" for a minute or two.
        var steps = new List<string>();
        var ready = false;
        var finished = await ConsoleFarewell.FinishStartAsync(
            async ct => { steps.Add("wait"); await Task.Delay(20, ct); return true; },
            async ct => { steps.Add("start"); _ = Task.Delay(150, ct).ContinueWith(_ => ready = true); await Task.Yield(); return "stream"; },
            _ => ready, TimeSpan.FromSeconds(3));
        check(finished == "stream" && ready && steps.SequenceEqual(new[] { "wait", "start" }), "an abandoned start is finished: session ready, stream started, negotiation waited for");
        var slow = System.Diagnostics.Stopwatch.StartNew();
        check(await ConsoleFarewell.FinishStartAsync(_ => Task.FromResult(true), _ => Task.FromResult<string?>("stream"), _ => false, TimeSpan.FromMilliseconds(300)) == "stream" && slow.ElapsedMilliseconds is >= 250 and < 1500,
            "a stream that does not finish negotiating in time is still handed back, so stopping it can report why no goodbye went out");
        check(await ConsoleFarewell.FinishStartAsync(_ => Task.FromResult(false), _ => throw new InvalidOperationException("must not start"), (string _) => true, TimeSpan.FromSeconds(1)) == null,
            "a console session that never became ready has no stream to start");
        check(await ConsoleFarewell.FinishStartAsync<string>(_ => throw new IOException("console gone"), _ => Task.FromResult<string?>("stream"), _ => true, TimeSpan.FromSeconds(1)) == null,
            "a failure while finishing the start is swallowed: this runs during cleanup");
        check(await ConsoleFarewell.FinishStartAsync<string>(async ct => { await Task.Delay(5000, ct); return true; }, _ => Task.FromResult<string?>("stream"), _ => true, TimeSpan.FromMilliseconds(200)) == null,
            "the whole attempt keeps to its time limit");

        var idle = new RPStreamV2(NullLogger<RPStreamV2>.Instance, NullLoggerFactory.Instance, new RemoteSession(), "127.0.0.1", 9, stopped.Token);
        await idle.StopAsync();
        check(idle.DisconnectOutcome.StartsWith("not sent"), $"a stream that never negotiated has nothing to say goodbye with, and says so: {idle.DisconnectOutcome}");
    }
}
