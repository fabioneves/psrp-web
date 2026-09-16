using System.Net;
using System.Net.Sockets;
using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using RemotePlay.Services.Device;

static class DiscoveryTests
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        check(DeviceDiscoveryService.FormatRegistKey(Convert.ToHexString(Encoding.ASCII.GetBytes("89abcdef\0\0\0\0\0\0\0\0"))) == "2309737967", "wake credentials decode padded registration keys as unsigned hexadecimal");
        var hosts = DiscoverySubnets.Parse("192.168.1.20/24,192.168.1.0/24");
        check(hosts.Count == 254 && hosts.Contains(IPAddress.Parse("192.168.1.20")) &&
            !hosts.Contains(IPAddress.Parse("192.168.1.0")) && !hosts.Contains(IPAddress.Parse("192.168.1.255")),
            "subnet discovery normalizes and deduplicates ranges without probing network or broadcast addresses");
        check(DiscoverySubnets.Parse(null).Count == 0, "unconfigured discovery retains the broadcast path");
        foreach (var invalid in new[] { "192.168.1.0/16", "8.8.8.0/24", "::1/24", "invalid", "10.0.0.0/24,10.0.1.0/24,10.0.2.0/24,10.0.3.0/24,10.0.4.0/24" })
        {
            var rejected = false;
            try { DiscoverySubnets.Parse(invalid); }
            catch (ArgumentException) { rejected = true; }
            check(rejected, "subnet discovery rejects invalid or excessive scope: " + invalid);
        }

        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var ps5 = new UdpClient(new IPEndPoint(IPAddress.Loopback, 9302));
        using var ps4 = new UdpClient(new IPEndPoint(IPAddress.Loopback, 987));
        var versions = new System.Collections.Concurrent.ConcurrentDictionary<string, bool>();
        var wakes = new System.Collections.Concurrent.ConcurrentDictionary<string, string>();
        async Task RespondAsync(UdpClient socket, string type, string version)
        {
            try
            {
                while (!stop.IsCancellationRequested)
                {
                    var request = await socket.ReceiveAsync(stop.Token);
                    if (Encoding.ASCII.GetString(request.Buffer).Contains("device-discovery-protocol-version:" + version))
                        versions[type] = true;
                    if (Encoding.ASCII.GetString(request.Buffer).StartsWith("WAKEUP"))
                    {
                        wakes[type] = Encoding.ASCII.GetString(request.Buffer);
                        continue;
                    }
                    var reply = Encoding.ASCII.GetBytes($"HTTP/1.1 200 Ok\nhost-id:fake-{type}\nhost-name:Test {type}\nhost-type:{type}\n");
                    await socket.SendAsync("invalid reply"u8.ToArray(), request.RemoteEndPoint, stop.Token);
                    await socket.SendAsync(reply, request.RemoteEndPoint, stop.Token);
                    await socket.SendAsync(reply, request.RemoteEndPoint, stop.Token);
                }
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        }
        var responders = Task.WhenAll(RespondAsync(ps5, "PS5", "00030010"), RespondAsync(ps4, "PS4", "00020020"));
        try
        {
            var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
                { ["DISCOVERY_SUBNETS"] = "127.0.0.0/30" }).Build();
            var discovery = new DeviceDiscoveryService(NullLogger<DeviceDiscoveryService>.Instance, configuration);
            var credential = Convert.ToHexString(Encoding.ASCII.GetBytes("89abcdef\0\0\0\0\0\0\0\0"));
            await discovery.WakeUpDeviceAsync("127.0.0.1", credential, "PS5", stop.Token);
            await discovery.WakeUpDeviceAsync("127.0.0.1", credential, "PS4", stop.Token);
            while (wakes.Count < 2) await Task.Delay(5, stop.Token);
            check(wakes["PS5"].Contains("user-credential:2309737967") && wakes["PS5"].Contains("00030010") && wakes["PS4"].Contains("00020020"), "wake requests reach the given IP with the correct credentials and PS4/PS5 ports and versions");
            var searches = await Task.WhenAll(discovery.DiscoverDevicesAsync(300), discovery.DiscoverDevicesAsync(300));
            check(searches.All(devices => devices.Count == 2 && devices.All(device => device.Ip == "127.0.0.1")),
                "concurrent subnet scans discover both console types, use responder IPs and discard duplicates and malformed replies");
            check(versions.ContainsKey("PS4") && versions.ContainsKey("PS5"), "subnet probes use the matching PS4 and PS5 discovery versions and ports");
            var directed = await Task.WhenAll(discovery.DiscoverDeviceAsync("127.0.0.1", 300), discovery.DiscoverDeviceAsync("127.0.0.1", 300));
            check(directed.All(device => device?.Ip == "127.0.0.1"), "concurrent direct probes use separate sockets and skip malformed replies");
            using var cancelled = new CancellationTokenSource();
            cancelled.Cancel();
            var propagated = false;
            try { await discovery.DiscoverDevicesAsync(300, cancelled.Token); }
            catch (OperationCanceledException) { propagated = true; }
            check(propagated, "subnet discovery propagates caller cancellation and releases its socket");
        }
        finally
        {
            await stop.CancelAsync();
            await responders;
        }
    }
}
