using System.Globalization;
using System.Net;
using System.Text.Json;
using RemotePlay.Contracts.Services;
using RemotePlay.Models.PlayStation;
using RemotePlay.Services.Device;

namespace RemotePlay.Services.Auth;

public sealed class PsnAutoPairing(PsnAccountStore accounts, PsnAccountClient client, PsnNative native,
    IDeviceDiscoveryService discovery, ConsolePairingStore pairing)
{
    public async Task<object> PairAsync(string userId, string hostIp, CancellationToken ct)
    {
        if (!IPAddress.TryParse(hostIp, out _)) throw new PsnSetupException(400, "Select a console or enter its IP address.");
        var account = await accounts.AccountAsync(userId, ct);
        var tokens = await accounts.TokensAsync(userId, ct);
        if (account == null || tokens == null) throw new PsnSetupException(400, "Sign in to PSN to pair automatically, or use a pairing PIN.");
        if (tokens.ExpiresAt < DateTimeOffset.UtcNow.AddMinutes(1))
        {
            tokens = await client.RefreshAsync(tokens, ct);
            await accounts.SaveAsync(userId, account, tokens, ct);
        }
        var console = await discovery.DiscoverDeviceAsync(hostIp, 3000, ct);
        if (console == null) throw new PsnSetupException(404, "The console is not responding. Turn it on and try again.");
        using var devices = await native.RunAsync(new { operation = "list", accessToken = tokens.AccessToken }, ct);
        var matching = devices.RootElement.EnumerateArray().Where(device => device.GetProperty("type").GetString() == console.HostType &&
            (console.HostType == "PS4" || device.GetProperty("name").GetString() == console.Name)).ToArray();
        if (matching.Length != 1) throw new PsnSetupException(409, "This console is not uniquely available for automatic pairing on your PSN account. Pair with a PIN instead.");
        using var result = await native.RunAsync(new { operation = "pair", accessToken = tokens.AccessToken, accountId = account.AccountId,
            type = console.HostType, uid = matching[0].GetProperty("uid").GetString() }, ct);
        var registration = Registration(result.RootElement, console);
        var saved = await pairing.SaveAsync(userId, console, registration, null, ct);
        return new { hostId = saved.HostId, hostName = saved.HostName, isRegistered = true };
    }

    public static RegisterResult Registration(JsonElement result, ConsoleInfo console)
    {
        var mac = result.GetProperty("mac").GetString()!;
        var key = result.GetProperty("rpKey").GetString()!;
        var registKey = result.GetProperty("registKey").GetString()!;
        if (!string.Equals(mac, console.Uuid.Replace(":", "").Replace("-", ""), StringComparison.OrdinalIgnoreCase) ||
            mac.Length != 12 || key.Length != 32 || registKey.Length != 32 ||
            !mac.Concat(key).Concat(registKey).All(Uri.IsHexDigit))
            throw new PsnSetupException(409, "The paired console did not match the selected console. Pair with its PIN instead.");
        return new RegisterResult { Success = true, RegistData = new()
        {
            [console.HostType + "-RegistKey"] = registKey, [console.HostType + "-Mac"] = mac,
            ["RP-Key"] = key, ["RP-KeyType"] = result.GetProperty("keyType").GetUInt32().ToString(CultureInfo.InvariantCulture)
        } };
    }
}
