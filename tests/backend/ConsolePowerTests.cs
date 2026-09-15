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
        var session = new Session();
        await power.SleepIdleAsync(device, session, default);
        check(session.Starts == 1 && session.Sleeps == 1 && session.Stops == 1 && discovery.Wakes == 1,
            "sleep opens only a control session, requests standby and releases it without waking");
        session.Ready = false;
        var refused = false;
        try { await power.SleepIdleAsync(device, session, default); }
        catch (IOException) { refused = true; }
        check(refused && session.Sleeps == 1 && session.Stops == 2, "failed sleep readiness still releases its control session");
        discovery.Wakes = 0;
        await power.SleepIdleAsync(device, session, default);
        check(session.Starts == 2 && discovery.Wakes == 0, "sleeping consoles stay asleep without opening a session");
        discovery.Wakes = 1;
        discovery.HostId = "different-console";
        var rejected = false;
        try { await power.EnsureReadyAsync(device, _ => Task.CompletedTask, default); }
        catch (IOException) { rejected = true; }
        check(rejected && discovery.Wakes == 1, "wake refuses a different console at the saved IP");
        check(await power.FindAsync("another-user", device.HostId!, default) == null, "wake lookup does not expose another user's paired console");
    }

    private sealed class Session : ISessionService
    {
        public int Starts, Stops, Sleeps;
        public bool Ready = true;
        public Task<RemoteSession> StartSessionAsync(string ip, DeviceCredentials credentials, string type, SessionStartOptions options, CancellationToken ct = default)
        {
            if (options.AutoStartStream || options.AutoConnectController || options.WakeupIfStandby) throw new Exception("Sleep must use control only");
            Starts++;
            return Task.FromResult(new RemoteSession());
        }
        public Task<bool> WaitReadyAsync(Guid id, TimeSpan timeout, CancellationToken ct = default) => Task.FromResult(Ready);
        public Task<bool> StandbyAsync(Guid id, CancellationToken ct = default) { Sleeps++; return Task.FromResult(true); }
        public Task<bool> StopSessionAsync(Guid id, CancellationToken ct = default) { Stops++; return Task.FromResult(true); }
        public Task<RemoteSession> StartSessionAsync(string ip, DeviceCredentials credentials, string type, CancellationToken ct = default) => throw new NotSupportedException();
        public Task<bool> SendInputAsync(Guid id, InputState input, CancellationToken ct = default) => throw new NotSupportedException();
        public Task<RemoteSession?> GetSessionAsync(Guid id, CancellationToken ct = default) => throw new NotSupportedException();
        public Task<IReadOnlyList<RemoteSession>> ListSessionsAsync(CancellationToken ct = default) => throw new NotSupportedException();
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
