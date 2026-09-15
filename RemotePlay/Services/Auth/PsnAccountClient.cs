using System.Buffers.Binary;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.WebUtilities;

namespace RemotePlay.Services.Auth;

public sealed record PsnAccount(string NumericId, string AccountId, string OnlineId, bool CanAutoPair);
public sealed record PsnTokens(string AccessToken, string RefreshToken, DateTimeOffset ExpiresAt, string ClientDuid);
public sealed record PsnAuthorization(PsnAccount Account, PsnTokens Tokens);
public sealed class PsnSetupException(int status, string message) : Exception(message)
{
    public int Status { get; } = status;
}

public sealed class PsnAccountClient(HttpClient client)
{
    public const string RedirectUri = "https://remoteplay.dl.playstation.net/remoteplay/redirect";
    private const string ClientId = "ba495a24-818c-472b-b12d-ff231c1b5745";
    private const string ClientSecret = "mvaiZkRsAsI1IBkY";
    private const string TokenUrl = "https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/token";
    private const string Scope = "psn:clientapp referenceDataService:countryConfig.read pushNotification:webSocket.desktop.connect sessionManager:remotePlaySession.system.update";

    public static string LoginUrl(string state, string duid) => QueryHelpers.AddQueryString(
        "https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/authorize", new Dictionary<string, string?>
        {
            ["service_entity"] = "urn:service-entity:psn", ["response_type"] = "code", ["client_id"] = ClientId,
            ["redirect_uri"] = RedirectUri, ["scope"] = Scope, ["state"] = state, ["duid"] = duid,
            ["request_locale"] = "en_US", ["ui"] = "pr", ["service_logo"] = "ps", ["layout_type"] = "popup",
            ["smcid"] = "remoteplay", ["prompt"] = "always", ["PlatformPrivacyWs1"] = "minimal"
        });

    public static PsnAccount Account(string numericId, string onlineId, bool canAutoPair)
    {
        if (!ulong.TryParse(numericId, NumberStyles.None, CultureInfo.InvariantCulture, out var id) || id == 0 || onlineId.Length > 100)
            throw new PsnSetupException(502, "The account service returned an invalid account ID.");
        var bytes = new byte[8];
        BinaryPrimitives.WriteUInt64LittleEndian(bytes, id);
        return new(id.ToString(CultureInfo.InvariantCulture), Convert.ToBase64String(bytes), onlineId, canAutoPair);
    }

    public async Task<PsnAuthorization> AuthorizeAsync(string code, string duid, CancellationToken ct)
    {
        using var token = await SendAsync(TokenRequest(new()
        {
            ["grant_type"] = "authorization_code", ["code"] = code, ["redirect_uri"] = RedirectUri, ["scope"] = Scope
        }), ct);
        var tokens = ReadTokens(token.RootElement, duid);
        using var request = new HttpRequestMessage(HttpMethod.Get, TokenUrl + "/" + Uri.EscapeDataString(tokens.AccessToken));
        Authenticate(request);
        using var account = await SendAsync(request, ct);
        var root = account.RootElement;
        if (!root.TryGetProperty("user_id", out var id)) throw new PsnSetupException(502, "Sony did not return an account ID.");
        var onlineId = root.TryGetProperty("online_id", out var name) && name.ValueKind == JsonValueKind.String ? name.GetString()! : "PlayStation account";
        return new(Account(id.ToString(), onlineId, true), tokens);
    }

    public async Task<PsnTokens> RefreshAsync(PsnTokens tokens, CancellationToken ct)
    {
        using var response = await SendAsync(TokenRequest(new()
            { ["grant_type"] = "refresh_token", ["refresh_token"] = tokens.RefreshToken, ["scope"] = Scope }), ct);
        return ReadTokens(response.RootElement, tokens.ClientDuid);
    }

    public async Task<PsnAccount> LookupAsync(string onlineId, CancellationToken ct)
    {
        if (!Regex.IsMatch(onlineId, "\\A[A-Za-z][A-Za-z0-9_-]{2,15}\\z"))
            throw new PsnSetupException(400, "Enter a PSN online name of 3–16 letters, numbers, hyphens or underscores, starting with a letter.");
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://psn.flipscreen.games/search.php?username=" + Uri.EscapeDataString(onlineId));
        using var response = await SendAsync(request, ct, lookup: true);
        var root = response.RootElement;
        if (!root.TryGetProperty("user_id", out var id) || !root.TryGetProperty("online_id", out var name) ||
            name.ValueKind != JsonValueKind.String || !string.Equals(name.GetString(), onlineId, StringComparison.OrdinalIgnoreCase))
            throw new PsnSetupException(502, "Public lookup returned an unexpected account. Use PSN sign-in or enter the account ID manually.");
        return Account(id.ToString(), name.GetString()!, false);
    }

    private static HttpRequestMessage TokenRequest(Dictionary<string, string> data)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, TokenUrl) { Content = new FormUrlEncodedContent(data) };
        Authenticate(request);
        return request;
    }

    private static void Authenticate(HttpRequestMessage request) => request.Headers.Authorization =
        new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.ASCII.GetBytes(ClientId + ":" + ClientSecret)));

    private static PsnTokens ReadTokens(JsonElement root, string duid)
    {
        if (!root.TryGetProperty("access_token", out var access) || access.ValueKind != JsonValueKind.String ||
            string.IsNullOrEmpty(access.GetString()) || !root.TryGetProperty("refresh_token", out var refresh) ||
            refresh.ValueKind != JsonValueKind.String || string.IsNullOrEmpty(refresh.GetString()) ||
            !root.TryGetProperty("expires_in", out var expires) || !expires.TryGetInt32(out var seconds) || seconds < 1 || seconds > 31536000)
            throw new PsnSetupException(502, "Sony returned an incomplete sign-in response. Start PSN sign-in again.");
        return new(access.GetString()!, refresh.GetString()!, DateTimeOffset.UtcNow.AddSeconds(seconds), duid);
    }

    private async Task<JsonDocument> SendAsync(HttpRequestMessage request, CancellationToken ct, bool lookup = false)
    {
        using (request)
        using (var response = await client.SendAsync(request, ct))
        {
            if (!response.IsSuccessStatusCode)
            {
                if (lookup && response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.BadRequest)
                    throw new PsnSetupException(404, "Account not found. Check the online name and allow Anyone to find you in PSN search, or use PSN sign-in.");
                if (!lookup && response.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.Unauthorized)
                    throw new PsnSetupException(400, "Your PSN sign-in has expired or was already used. Start PSN sign-in again.");
                throw new PsnSetupException(503, lookup
                    ? "Public lookup is unavailable. Use PSN sign-in or enter your account ID manually."
                    : "Sony sign-in is temporarily unavailable. Please try again.");
            }
            var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                document.Dispose();
                throw new JsonException("Expected an account response object.");
            }
            return document;
        }
    }
}
