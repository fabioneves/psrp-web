namespace RemotePlay.Services.Auth;

/// <summary>
/// Brute-force protection for local sign-in. An account locks for 1 minute after 5 consecutive failures, doubling
/// with each further failure up to 15 minutes; an address locks for 10 minutes after 20 failures within 10 minutes.
/// Counters live in memory, which is enough for a single-instance server, and reset after a quiet quarter hour.
/// </summary>
public sealed class LoginAttempts(TimeProvider clock)
{
    public const int AccountFailures = 5;
    public const int AddressFailures = 20;
    private static readonly TimeSpan Quiet = TimeSpan.FromMinutes(15), AddressWindow = TimeSpan.FromMinutes(10), AddressLock = TimeSpan.FromMinutes(10), MaxLock = TimeSpan.FromMinutes(15);
    private sealed class Record { public int Failures; public DateTimeOffset LockedUntil, LastFailure; }
    private readonly Dictionary<string, Record> accounts = new(StringComparer.OrdinalIgnoreCase), addresses = new();

    /// <summary>How long the caller must wait, or null when the attempt may proceed.</summary>
    public TimeSpan? Blocked(string account, string address)
    {
        var now = clock.GetUtcNow();
        lock (accounts)
        {
            Prune(now);
            var wait = TimeSpan.Zero;
            if (accounts.TryGetValue(account, out var user) && user.LockedUntil > now) wait = user.LockedUntil - now;
            if (addresses.TryGetValue(address, out var host) && host.LockedUntil > now && host.LockedUntil - now > wait) wait = host.LockedUntil - now;
            return wait > TimeSpan.Zero ? wait : null;
        }
    }

    public void Failed(string account, string address)
    {
        var now = clock.GetUtcNow();
        lock (accounts)
        {
            var user = Get(accounts, account);
            user.Failures++; user.LastFailure = now;
            if (user.Failures >= AccountFailures)
            {
                var minutes = Math.Min(MaxLock.TotalMinutes, Math.Pow(2, user.Failures - AccountFailures));
                user.LockedUntil = now.AddMinutes(minutes);
            }
            var host = Get(addresses, address);
            if (now - host.LastFailure > AddressWindow) host.Failures = 0;
            host.Failures++; host.LastFailure = now;
            if (host.Failures >= AddressFailures) host.LockedUntil = now + AddressLock;
        }
    }

    public void Succeeded(string account) { lock (accounts) accounts.Remove(account); }

    private static Record Get(Dictionary<string, Record> table, string key)
    {
        if (!table.TryGetValue(key, out var record)) table[key] = record = new Record();
        return record;
    }

    private void Prune(DateTimeOffset now)
    {
        foreach (var table in new[] { accounts, addresses })
            foreach (var key in table.Where(pair => pair.Value.LockedUntil <= now && now - pair.Value.LastFailure > Quiet).Select(pair => pair.Key).ToArray())
                table.Remove(key);
    }
}
