using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using RemotePlay.Models.Context;

namespace RemotePlay.Services.Auth;

public sealed class PsnAccountStore(RPContext db, IDataProtectionProvider protection)
{
    private sealed record Saved(PsnAccount Account, string? ProtectedTokens);
    private static string Key(string userId) => "psn-account/" + userId;

    private async Task<Saved?> ReadAsync(string userId, CancellationToken ct)
    {
        var value = await db.Settings.Where(row => row.Key == Key(userId)).Select(row => row.Value).SingleOrDefaultAsync(ct);
        return value == null ? null : JsonSerializer.Deserialize<Saved>(value);
    }

    public async Task<PsnAccount?> AccountAsync(string userId, CancellationToken ct) => (await ReadAsync(userId, ct))?.Account;

    public async Task<PsnTokens?> TokensAsync(string userId, CancellationToken ct)
    {
        var saved = await ReadAsync(userId, ct);
        return saved?.ProtectedTokens == null ? null : JsonSerializer.Deserialize<PsnTokens>(
            protection.CreateProtector("psn-tokens", userId).Unprotect(saved.ProtectedTokens));
    }

    public async Task SaveAsync(string userId, PsnAccount account, PsnTokens? tokens, CancellationToken ct)
    {
        var encrypted = tokens == null ? null : protection.CreateProtector("psn-tokens", userId).Protect(JsonSerializer.Serialize(tokens));
        var value = JsonSerializer.Serialize(new Saved(account, encrypted));
        var key = Key(userId);
        var id = Guid.NewGuid().ToString("N");
        await db.Database.ExecuteSqlInterpolatedAsync($"INSERT INTO t_settings (id, key, value, category, is_encrypted, created_at) VALUES ({id}, {key}, {value}, 'psn-account', false, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()", ct);
    }

    public Task<int> ClearAsync(string userId, CancellationToken ct) => db.Settings.Where(row => row.Key == Key(userId)).ExecuteDeleteAsync(ct);
}
