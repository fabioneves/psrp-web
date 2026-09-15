using Microsoft.EntityFrameworkCore;
using RemotePlay.Contracts.Services;
using RemotePlay.Models.Context;
using RemotePlay.Models.PlayStation;
using PairedDevice = RemotePlay.Models.DB.PlayStation.Device;

namespace RemotePlay.Services.Software;

public sealed class ConsolePower(RPContext db, IDeviceDiscoveryService discovery)
{
    public async Task<PairedDevice?> FindAsync(string userId, string hostId, CancellationToken ct) =>
        await db.UserDevices.Where(binding => binding.UserId == userId && binding.IsActive && binding.Device != null &&
            binding.Device.HostId == hostId && binding.Device.IsRegistered == true).Select(binding => binding.Device!).SingleOrDefaultAsync(ct);

    public async Task EnsureReadyAsync(PairedDevice device, Func<string, Task> report, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(25));
        try
        {
            var found = await discovery.DiscoverDeviceAsync(device.IpAddress!, 1000, deadline.Token);
            ValidateConsole(found, device);
            if (!Ready(found))
            {
                await report("Waking console…");
                if (!await discovery.WakeUpDeviceAsync(device.IpAddress!, device.RegistKey!, device.HostType!, deadline.Token))
                    throw new IOException("Could not send the console wake request.");
                do
                {
                    await Task.Delay(500, deadline.Token);
                    found = await discovery.DiscoverDeviceAsync(device.IpAddress!, 1000, deadline.Token);
                    ValidateConsole(found, device);
                } while (!Ready(found));
            }
            device.Status = found!.status;
            await db.SaveChangesAsync(deadline.Token);
            await report("Console awake. Connecting…");
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new TimeoutException("The console did not wake. Enable Stay Connected to the Internet and Turning On from Network in its Rest Mode settings, or turn it on manually.");
        }
    }

    public async Task SleepIdleAsync(PairedDevice device, ISessionService sessions, CancellationToken ct)
    {
        var found = await discovery.DiscoverDeviceAsync(device.IpAddress!, 1000, ct);
        ValidateConsole(found, device);
        if (string.Equals(found?.status, "STANDBY", StringComparison.OrdinalIgnoreCase)) return;
        if (!Ready(found)) throw new IOException("The console is offline or did not respond. Turn it on before requesting rest mode.");
        var session = await sessions.StartSessionAsync(device.IpAddress!, new DeviceCredentials
        {
            HostId = device.HostId!, HostName = device.HostName!, HostIp = device.IpAddress!,
            RegistrationKey = Convert.FromHexString(device.RegistKey!), ServerKey = Convert.FromHexString(device.RPKey!)
        }, device.HostType!, new SessionStartOptions
        {
            AutoStartStream = false, AutoConnectController = false, WakeupIfStandby = false
        }, ct);
        try
        {
            if (!await sessions.WaitReadyAsync(session.Id, TimeSpan.FromSeconds(10), ct) ||
                !await sessions.StandbyAsync(session.Id, ct))
                throw new IOException("The console did not accept the rest-mode request. Try connecting first.");
        }
        finally { await sessions.StopSessionAsync(session.Id, CancellationToken.None); }
    }

    private static bool Ready(ConsoleInfo? console) => string.Equals(console?.status, "OK", StringComparison.OrdinalIgnoreCase);

    private static void ValidateConsole(ConsoleInfo? found, PairedDevice device)
    {
        if (found != null && !string.Equals(found.Uuid, device.HostId, StringComparison.OrdinalIgnoreCase))
            throw new IOException("A different console is using the saved IP address. Check the console IP before connecting.");
    }
}
