using System.Net;
using System.Buffers.Binary;
using System.Net.Sockets;
using System.Reflection;
using Microsoft.Extensions.Logging.Abstractions;
using RemotePlay.Models.PlayStation;
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
    }
}
