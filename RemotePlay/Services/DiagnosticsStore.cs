using System.Text.Json;
using System.Text.RegularExpressions;

namespace RemotePlay.Services;

/// <summary>
/// Diagnostics captures uploaded from browsers that cannot save files (the Tesla), kept per account on disk
/// (DIAGNOSTICS_DIR, default /data/diagnostics) with the newest <see cref="Keep"/> retained.
/// </summary>
public sealed partial class DiagnosticsStore(string? root = null)
{
    public const int MaxBytes = 2 * 1024 * 1024;
    public const int Keep = 20;
    private readonly string root = root ?? (Environment.GetEnvironmentVariable("DIAGNOSTICS_DIR") is { Length: > 0 } dir ? dir : "/data/diagnostics");
    public sealed record Entry(string Name, long Bytes, DateTimeOffset SavedAt);

    [GeneratedRegex("^[0-9]{8}T[0-9]{6}Z(-[0-9]+)?\\.json$")] private static partial Regex NamePattern();
    public static bool ValidName(string name) => NamePattern().IsMatch(name);

    private string UserDir(string userId) => Path.Combine(root, string.Concat(userId.Where(char.IsLetterOrDigit)));

    /// <summary>Validates a capture (a JSON object within the size limit), stores it and prunes older captures.</summary>
    public async Task<Entry> SaveAsync(string userId, JsonElement capture, DateTimeOffset now, CancellationToken ct)
    {
        if (capture.ValueKind != JsonValueKind.Object) throw new ArgumentException("Diagnostics must be a JSON object.");
        var raw = capture.GetRawText();
        if (raw.Length > MaxBytes) throw new ArgumentException($"Diagnostics exceed {MaxBytes / 1024 / 1024} MB.");
        var dir = UserDir(userId);
        Directory.CreateDirectory(dir);
        var stamp = now.ToString("yyyyMMdd'T'HHmmss'Z'");
        var name = stamp + ".json";
        for (var n = 1; File.Exists(Path.Combine(dir, name)); n++) name = $"{stamp}-{n}.json";
        await File.WriteAllTextAsync(Path.Combine(dir, name), raw, ct);
        foreach (var stale in List(userId).Skip(Keep)) File.Delete(Path.Combine(dir, stale.Name));
        return new Entry(name, raw.Length, now);
    }

    /// <summary>Newest first.</summary>
    public IReadOnlyList<Entry> List(string userId)
    {
        var dir = UserDir(userId);
        if (!Directory.Exists(dir)) return [];
        // "…Z.json" is the first capture of its second and "…Z-n.json" the later ones; sort by second, then suffix.
        static (string Stamp, int Suffix) Order(string name)
        {
            var stem = name[..^5];
            var dash = stem.IndexOf('-');
            return dash < 0 ? (stem, 0) : (stem[..dash], int.Parse(stem[(dash + 1)..]));
        }
        return new DirectoryInfo(dir).GetFiles("*.json").Where(file => ValidName(file.Name))
            .OrderByDescending(file => Order(file.Name)).Select(file => new Entry(file.Name, file.Length, file.LastWriteTimeUtc)).ToList();
    }

    public string? PathOf(string userId, string name) =>
        ValidName(name) && File.Exists(Path.Combine(UserDir(userId), name)) ? Path.Combine(UserDir(userId), name) : null;
}
