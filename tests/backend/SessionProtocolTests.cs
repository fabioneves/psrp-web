using System.Net;
using System.Net.Sockets;
using System.Text;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using RemotePlay.Contracts.Services;
using RemotePlay.Models.PlayStation;
using RemotePlay.Services.Session;

static class SessionProtocolTests
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        foreach (var (coalesced, remoteClose) in new[] { (false, false), (true, false), (false, true) })
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(4));
            var ct = deadline.Token;
            using var provider = new ServiceCollection().BuildServiceProvider();
            var service = new SessionService(NullLogger<SessionService>.Instance, new Discovery(), Options.Create(new SessionConfig()), provider);
            using var listener = new TcpListener(IPAddress.Loopback, 9295);
            listener.Start();
            var console = Task.Run(async () =>
            {
                using (var init = await listener.AcceptTcpClientAsync(ct))
                {
                    await ReadHeaders(init.GetStream(), ct);
                    await init.GetStream().WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nRP-Nonce: AAAAAAAAAAAAAAAAAAAAAA==\r\n\r\n"), ct);
                }
                using var control = await listener.AcceptTcpClientAsync(ct);
                var stream = control.GetStream();
                await ReadHeaders(stream, ct);
                byte[] heartbeat = [0, 0, 0, 0, 0, 254, 0, 0];
                var response = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\n\r\n");
                await stream.WriteAsync(coalesced ? response.Concat(heartbeat).ToArray() : response, ct);
                if (!coalesced) { await Task.Delay(100, ct); await stream.WriteAsync(heartbeat, ct); }
                var reply = new byte[8];
                await stream.ReadExactlyAsync(reply, ct);
                check(reply.SequenceEqual(new byte[] { 0, 0, 0, 0, 1, 254, 0, 0 }),
                    coalesced ? "control messages coalesced with HTTP headers are retained" : "console heartbeat reply has no payload");
                if (remoteClose) return;
                var standby = new byte[8];
                await stream.ReadExactlyAsync(standby, ct);
                check(standby.SequenceEqual(new byte[] { 0, 0, 0, 0, 0, 0x50, 0, 0 }),
                    "standby sends the rest-mode control message before closing the session");
                var closed = new byte[1];
                check(await stream.ReadAsync(closed, ct) == 0, "stopping a session closes the console control socket");
            }, ct);
            var session = await service.StartSessionAsync("127.0.0.1", new DeviceCredentials { RegistrationKey = new byte[16], ServerKey = new byte[16] }, "PS5", ct);
            if (remoteClose)
            {
                await console;
                while ((await service.ListSessionsAsync(ct)).Count != 0) await Task.Delay(10, ct);
                check((await service.ListSessionsAsync(ct)).Count == 0, "a closed console control connection removes its orphaned session automatically");
            }
            else
            {
                try
                {
                    await Task.Delay(200, ct);
                    check(await service.StandbyAsync(session.Id, ct), "an active console session accepts a rest-mode request");
                }
                finally { await service.StopSessionAsync(session.Id, ct); }
            }
            await console;
        }
        foreach (var (response, expected) in new[] {
            ("HTTP/1.1 503 Busy\r\nRP-Application-Reason: 80108b10\r\n\r\n", "occupied"),
            ("HTTP/1.1 503 Error\r\nRP-Application-Reason: 80108b15\r\n\r\n", "crash"),
            ("HTTP/1.1 403 Forbidden\r\nRP-Application-Reason: 80108b77\r\n\r\n", "reason 80108b77"),
            ("HTTP/1.1 200 OK\r\n\r\n", "incomplete"),
            ("", "closed"),
            ("HTTP/1.1 200 OK\r\n", "stopped responding") })
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            var ct = deadline.Token;
            using var provider = new ServiceCollection().BuildServiceProvider();
            var service = new SessionService(NullLogger<SessionService>.Instance, new Discovery(), Options.Create(new SessionConfig { ReadTimeoutMs = 200 }), provider);
            using var listener = new TcpListener(IPAddress.Loopback, 9295);
            listener.Start();
            var console = Task.Run(async () =>
            {
                using var client = await listener.AcceptTcpClientAsync(ct);
                var stream = client.GetStream();
                await ReadHeaders(stream, ct);
                if (response.Length == 0) return;
                var bytes = Encoding.ASCII.GetBytes(response);
                await stream.WriteAsync(bytes.AsMemory(0, bytes.Length - 2), ct);
                await Task.Delay(10, ct);
                await stream.WriteAsync(bytes.AsMemory(bytes.Length - 2), ct);
                check(await stream.ReadAsync(new byte[1], ct) == 0, "rejected or stalled handshake releases its socket");
            }, ct);
            Exception? failure = null;
            try { await service.StartSessionAsync("127.0.0.1", new DeviceCredentials { RegistrationKey = new byte[16], ServerKey = new byte[16] }, "PS5", ct); }
            catch (Exception ex) { failure = ex; }
            check(failure is ConsoleHandshakeException or TimeoutException && failure.Message.Contains(expected), $"handshake reports {expected} distinctly");
            check(((failure as ConsoleHandshakeException)?.ConsoleBusy ?? false) == (expected == "occupied"), $"handshake {expected} flags the console as busy only for the occupied reason");
            await console;
        }

    }

    private static async Task ReadHeaders(NetworkStream stream, CancellationToken ct)
    {
        var bytes = new byte[1];
        var text = new StringBuilder();
        while (!text.ToString().EndsWith("\r\n\r\n"))
        {
            await stream.ReadExactlyAsync(bytes, ct);
            text.Append((char)bytes[0]);
        }
    }

    private sealed class Discovery : IDeviceDiscoveryService
    {
        public Task<List<ConsoleInfo>> DiscoverDevicesAsync(int timeoutMs = 2000, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<ConsoleInfo?> DiscoverDeviceAsync(string hostIp, int timeoutMs = 2000, CancellationToken cancellationToken = default) => Task.FromResult<ConsoleInfo?>(new ConsoleInfo(hostIp, "Test", "test", "PS5", status: "Ok"));
        public Task<bool> WakeUpDeviceAsync(string host, string credential, string hostType, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }
}
