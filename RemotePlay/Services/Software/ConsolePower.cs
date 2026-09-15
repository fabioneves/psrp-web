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

    private static bool Ready(ConsoleInfo? console) => string.Equals(console?.status, "OK", StringComparison.OrdinalIgnoreCase);

    private static void ValidateConsole(ConsoleInfo? found, PairedDevice device)
    {
        if (found != null && !string.Equals(found.Uuid, device.HostId, StringComparison.OrdinalIgnoreCase))
            throw new IOException("A different console is using the saved IP address. Check the console IP before connecting.");
    }
}
