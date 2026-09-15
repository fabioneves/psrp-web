using Microsoft.EntityFrameworkCore;
using Newtonsoft.Json.Linq;
using RemotePlay.Models.Context;
using RemotePlay.Models.PlayStation;
using PairedDevice = RemotePlay.Models.DB.PlayStation.Device;

namespace RemotePlay.Services.Device;

public sealed class ConsolePairingStore(RPContext db)
{
    public async Task<PairedDevice> SaveAsync(string userId, ConsoleInfo console, RegisterResult registration, string? name, CancellationToken ct)
    {
        if (!registration.Success || registration.RegistData == null) throw new InvalidOperationException("Console registration did not succeed.");
        var data = registration.RegistData;
        var device = await db.PSDevices.SingleOrDefaultAsync(row => row.HostId == console.Uuid, ct);
        if (device == null)
        {
            device = new PairedDevice { Id = Guid.NewGuid().ToString("N"), uuid = Guid.NewGuid(), HostId = console.Uuid, HostName = console.Name };
            db.PSDevices.Add(device);
        }
        device.HostName = console.Name;
        device.HostType = console.HostType;
        device.IpAddress = console.Ip;
        device.SystemVersion = console.SystemVerion;
        device.DiscoverProtocolVersion = console.DeviceDiscoverPotocolVersion;
        device.Status = console.status;
        device.IsRegistered = true;
        device.APBssid = data.GetValueOrDefault("AP-Bssid");
        device.RegistData = JObject.FromObject(data);
        device.RegistKey = data.FirstOrDefault(pair => pair.Key.Contains("RegistKey")).Value;
        device.MacAddress = data.FirstOrDefault(pair => pair.Key.Contains("Mac")).Value;
        device.RPKeyType = data.GetValueOrDefault("RP-KeyType");
        device.RPKey = data.GetValueOrDefault("RP-Key");
        var binding = await db.UserDevices.SingleOrDefaultAsync(row => row.UserId == userId && row.DeviceId == device.Id, ct);
        if (binding == null)
        {
            binding = new Models.DB.Auth.UserDevice { Id = Guid.NewGuid().ToString(), UserId = userId, DeviceId = device.Id,
                DeviceName = name ?? console.Name, DeviceType = console.HostType, IsActive = true };
            db.UserDevices.Add(binding);
        }
        binding.IsActive = true;
        binding.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return device;
    }
}
