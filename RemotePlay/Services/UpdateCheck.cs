using System.Text.Json;

namespace RemotePlay.Services;

/// <summary>
/// Compares the running build (APP_VERSION, the short git commit baked in at build time) with the newest commit on
/// the repository's main branch, checked at most every six hours. UPDATE_CHECK_REPO=owner/name selects the
/// repository; an empty value disables the check.
/// </summary>
public sealed class UpdateCheck(IHttpClientFactory clients, TimeProvider clock)
{
    public sealed record Status(string Version, string? Latest, bool UpdateAvailable, DateTimeOffset? CheckedAt);
    private static readonly TimeSpan Interval = TimeSpan.FromHours(6);
    private readonly SemaphoreSlim gate = new(1, 1);
    private Status? cached;

    public string Version { get; } = Environment.GetEnvironmentVariable("APP_VERSION") is { Length: > 0 } version ? version : "dev";
    public string Repository { get; } = Environment.GetEnvironmentVariable("UPDATE_CHECK_REPO") ?? "fabioneves/psrp-web";

    /// <summary>A build is current when the newest commit starts with its short hash; a dev build never reports an update.</summary>
    public static bool IsUpdate(string version, string? latestSha) =>
        version != "dev" && latestSha is { Length: >= 7 } && !latestSha.StartsWith(version, StringComparison.OrdinalIgnoreCase);

    public async Task<Status> GetAsync(CancellationToken ct)
    {
        if (Repository.Length == 0 || Version == "dev") return new Status(Version, null, false, null);
        await gate.WaitAsync(ct);
        try
        {
            if (cached != null && cached.CheckedAt is { } at && clock.GetUtcNow() - at < Interval) return cached;
            string? latest = null;
            try
            {
                using var client = clients.CreateClient();
                client.Timeout = TimeSpan.FromSeconds(8);
                using var request = new HttpRequestMessage(HttpMethod.Get, $"https://api.github.com/repos/{Repository}/commits/main");
                request.Headers.UserAgent.ParseAdd("player-one-update-check");
                request.Headers.Accept.ParseAdd("application/vnd.github+json");
                using var response = await client.SendAsync(request, ct);
                if (response.IsSuccessStatusCode)
                    latest = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct)).RootElement.GetProperty("sha").GetString();
            }
            catch (Exception) when (!ct.IsCancellationRequested) { }
            cached = new Status(Version, latest?[..Math.Min(7, latest.Length)], IsUpdate(Version, latest), clock.GetUtcNow());
            return cached;
        }
        finally { gate.Release(); }
    }
}
