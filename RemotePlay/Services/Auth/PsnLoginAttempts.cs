using System.Security.Cryptography;
using Microsoft.AspNetCore.WebUtilities;

namespace RemotePlay.Services.Auth;

public sealed class PsnLoginAttempts(TimeProvider clock)
{
    private sealed record Attempt(string State, string Duid, DateTimeOffset ExpiresAt);
    private readonly Dictionary<string, Attempt> attempts = new();

    public string Start(string userId)
    {
        lock (attempts)
        {
            foreach (var key in attempts.Where(pair => pair.Value.ExpiresAt <= clock.GetUtcNow()).Select(pair => pair.Key).ToArray()) attempts.Remove(key);
            if (attempts.Count >= 1000 && !attempts.ContainsKey(userId)) throw new PsnSetupException(503, "PSN sign-in is busy. Please try again shortly.");
            var attempt = new Attempt(Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),
                "0000000700410080" + Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant(), clock.GetUtcNow().AddMinutes(10));
            attempts[userId] = attempt;
            return PsnAccountClient.LoginUrl(attempt.State, attempt.Duid);
        }
    }

    public (string Code, string Duid) Consume(string userId, string redirectUrl)
    {
        if (redirectUrl.Length > 4096 || !Uri.TryCreate(redirectUrl, UriKind.Absolute, out var uri) ||
            uri.GetLeftPart(UriPartial.Path) != PsnAccountClient.RedirectUri || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0)
            throw new PsnSetupException(400, "Paste the complete redirect URL from Sony after signing in.");
        var query = QueryHelpers.ParseQuery(uri.Query);
        if (!query.TryGetValue("code", out var code) || code.Count != 1 || string.IsNullOrWhiteSpace(code[0]) || code[0]!.Length > 2048 ||
            !query.TryGetValue("state", out var state) || state.Count != 1)
            throw new PsnSetupException(400, "The redirect URL is missing its sign-in code or state. Start PSN sign-in again.");
        lock (attempts)
        {
            if (!attempts.TryGetValue(userId, out var attempt) || attempt.ExpiresAt <= clock.GetUtcNow() || attempt.State != state[0])
                throw new PsnSetupException(400, "This sign-in link has expired or belongs to another session. Start PSN sign-in again.");
            attempts.Remove(userId);
            return (code[0]!, attempt.Duid);
        }
    }
}
