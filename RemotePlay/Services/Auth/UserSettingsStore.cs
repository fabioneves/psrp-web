using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using RemotePlay.Models.Context;

namespace RemotePlay.Services.Auth;

/// <summary>Per-account player settings (stream profile, controller, audio, per-console profiles) so they follow the user across browsers.</summary>
public sealed class UserSettingsStore(RPContext db)
{
    public const int MaxBytes = 32 * 1024;
    private static string Key(string userId) => "user-settings/" + userId;

    /// <summary>Accepts a JSON object no larger than <see cref="MaxBytes"/>; anything else is rejected before it reaches storage.</summary>
    public static string? Validate(JsonElement settings)
    {
        if (settings.ValueKind != JsonValueKind.Object) return "Settings must be a JSON object.";
        var raw = settings.GetRawText();
        return raw.Length > MaxBytes ? $"Settings exceed {MaxBytes / 1024} KB." : null;
    }

    public async Task<string?> ReadAsync(string userId, CancellationToken ct) =>
        await db.Settings.Where(row => row.Key == Key(userId)).Select(row => row.Value).SingleOrDefaultAsync(ct);

    public async Task SaveAsync(string userId, JsonElement settings, CancellationToken ct)
    {
        if (Validate(settings) is { } problem) throw new ArgumentException(problem);
        var value = settings.GetRawText();
        var key = Key(userId);
        var id = Guid.NewGuid().ToString("N");
        await db.Database.ExecuteSqlInterpolatedAsync($"INSERT INTO t_settings (id, key, value, category, is_encrypted, created_at) VALUES ({id}, {key}, {value}, 'user-settings', false, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()", ct);
    }
}
