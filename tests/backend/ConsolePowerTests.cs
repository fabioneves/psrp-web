using RemotePlay.Contracts.Services;
using RemotePlay.Models.Context;
using RemotePlay.Models.PlayStation;
using RemotePlay.Services.Software;
using PairedDevice = RemotePlay.Models.DB.PlayStation.Device;

static class ConsolePowerTests
{
    public static async Task RunAsync(RPContext db, PairedDevice device, Action<bool, string> check)
    {
        var discovery = new Discovery(device.HostId!);
        var power = new ConsolePower(db, discovery);
        var messages = new List<string>();
        await power.EnsureReadyAsync(device, text => { messages.Add(text); return Task.CompletedTask; }, default);
        check(discovery.Wakes == 1 && device.Status == "Ok" && messages.First() == "Waking console…", "standby startup sends wake, waits for readiness and updates saved status");
        await power.EnsureReadyAsync(device, _ => Task.CompletedTask, default);
        check(discovery.Wakes == 1, "an awake console connects without another wake request");
        discovery.HostId = "different-console";
        var rejected = false;
        try { await power.EnsureReadyAsync(device, _ => Task.CompletedTask, default); }
        catch (IOException) { rejected = true; }
        check(rejected && discovery.Wakes == 1, "wake refuses a different console at the saved IP");
        check(await power.FindAsync("another-user", device.HostId!, default) == null, "wake lookup does not expose another user's paired console");
    }

    private sealed class Discovery(string hostId) : IDeviceDiscoveryService
    {
        public string HostId = hostId;
        public int Wakes;
        public Task<List<ConsoleInfo>> DiscoverDevicesAsync(int timeoutMs = 2000, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<ConsoleInfo?> DiscoverDeviceAsync(string hostIp, int timeoutMs = 2000, CancellationToken cancellationToken = default) =>
            Task.FromResult<ConsoleInfo?>(new ConsoleInfo(hostIp, "Test", HostId, "PS5", status: Wakes == 0 ? "STANDBY" : "Ok"));
        public Task<bool> WakeUpDeviceAsync(string host, string credential, string hostType, CancellationToken cancellationToken = default) { Wakes++; return Task.FromResult(true); }
    }
}
