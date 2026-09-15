using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using RemotePlay.Models.Context;
using RemotePlay.Models.DB;
using RemotePlay.Models.PlayStation;
using RemotePlay.Services.Auth;
using RemotePlay.Services.Device;

static class PsnStorageTests
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        var builder = new NpgsqlDataSourceBuilder(Environment.GetEnvironmentVariable("TEST_DATABASE"));
        builder.UseJsonNet();
        await using var source = builder.Build();
        var options = new DbContextOptionsBuilder<RPContext>().UseNpgsql(source).Options;
        var userId = "storage-test-" + Guid.NewGuid().ToString("N");
        var directory = Directory.CreateTempSubdirectory("psn-keys-");
        var account = PsnAccountClient.Account("72623859790382856", "StorageTest", true);
        var tokens = new PsnTokens("test-access-secret", "test-refresh-secret", DateTimeOffset.UtcNow.AddHours(1), "test-duid");
        var console = new ConsoleInfo("192.0.2.1", "Storage test", userId, "PS5");
        string? deviceId = null;
        try
        {
            await using (var db = new RPContext(options))
            {
                var store = new PsnAccountStore(db, DataProtectionProvider.Create(directory));
                await store.SaveAsync(userId, account, tokens, default);
                var raw = await db.Settings.Where(row => row.Key == "psn-account/" + userId).Select(row => row.Value).SingleAsync();
                check(!raw!.Contains(tokens.AccessToken) && !raw.Contains(tokens.RefreshToken), "Sony tokens are encrypted in PostgreSQL");
                check(await store.AccountAsync(userId + "-other", default) == null && await store.TokensAsync(userId + "-other", default) == null, "PSN storage isolates local users");
                db.Users.Add(new User { Id = userId, Username = userId, Email = userId + "@example.test", PasswordHash = "test-only" });
                await db.SaveChangesAsync();
                var pairing = new ConsolePairingStore(db);
                var registration = new RegisterResult { Success = true, RegistData = new() { ["RP-Key"] = new string('a', 32), ["PS5-RegistKey"] = new string('b', 32), ["PS5-Mac"] = "001122334455" } };
                var device = await pairing.SaveAsync(userId, console, registration, null, default);
                deviceId = device.Id;
                check(await db.UserDevices.AnyAsync(row => row.UserId == userId && row.DeviceId == device.Id && row.IsActive), "pairing saves the console and its user binding atomically");
                await pairing.SaveAsync(userId, console, registration, null, default);
                check(await db.UserDevices.CountAsync(row => row.UserId == userId) == 1, "pairing an existing console reuses its user binding");
            }
            await using (var db = new RPContext(options))
            {
                var store = new PsnAccountStore(db, DataProtectionProvider.Create(directory));
                check(await store.AccountAsync(userId, default) == account && await store.TokensAsync(userId, default) == tokens, "PSN metadata and encrypted tokens survive a new database context and key provider");
                await store.SaveAsync(userId, account with { CanAutoPair = false }, null, default);
                check(await store.TokensAsync(userId, default) == null, "switching to public lookup removes old Sony credentials");
                await store.ClearAsync(userId, default);
                check(await store.AccountAsync(userId, default) == null, "forgetting a PSN account removes its saved data");
            }
        }
        finally
        {
            await using var db = new RPContext(options);
            await db.Settings.Where(row => row.Key == "psn-account/" + userId).ExecuteDeleteAsync();
            await db.Users.Where(row => row.Id == userId).ExecuteDeleteAsync();
            if (deviceId != null) await db.PSDevices.Where(row => row.Id == deviceId).ExecuteDeleteAsync();
            directory.Delete(true);
        }
    }
}
