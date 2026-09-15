using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.WebUtilities;
using RemotePlay.Services.Auth;
using RemotePlay.Models.PlayStation;

static class PsnTests
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        var clock = new TestClock();
        var attempts = new PsnLoginAttempts(clock);
        var url = attempts.Start("alice");
        var query = QueryHelpers.ParseQuery(new Uri(url).Query);
        var redirect = PsnAccountClient.RedirectUri + "?code=test-code&state=" + query["state"];
        check(new Uri(url).Host == "auth.api.sonyentertainmentnetwork.com" && query["duid"].ToString().Length == 48,
            "PSN sign-in uses Sony with a per-attempt device ID and state");
        void Rejected(Action action, string label)
        {
            var rejected = false;
            try { action(); } catch (PsnSetupException) { rejected = true; }
            check(rejected, label);
        }
        Rejected(() => attempts.Consume("bob", redirect), "another local user cannot consume a PSN sign-in attempt");
        Rejected(() => attempts.Consume("alice", redirect.Replace("remoteplay.dl.playstation.net", "untrusted.example")), "PSN completion rejects another callback host");
        Rejected(() => attempts.Consume("alice", redirect + "&code=second"), "PSN completion rejects duplicate callback codes");
        check(attempts.Consume("alice", redirect).Code == "test-code", "valid PSN callback returns its single-use code");
        Rejected(() => attempts.Consume("alice", redirect), "PSN callback replay is rejected");
        query = QueryHelpers.ParseQuery(new Uri(attempts.Start("alice")).Query);
        clock.Now = clock.Now.AddMinutes(11);
        Rejected(() => attempts.Consume("alice", PsnAccountClient.RedirectUri + "?code=x&state=" + query["state"]), "PSN callback expires after ten minutes");
        check(PsnAccountClient.Account("72623859790382856", "Example", true).AccountId == "CAcGBQQDAgE=",
            "Sony decimal account IDs use exact little-endian encoding rather than hexadecimal parsing");
        Rejected(() => PsnAccountClient.Account("18446744073709551616", "Example", false), "account ID overflow is rejected");

        var calls = new List<string>();
        using var http = new HttpClient(new Handler(async (request, ct) =>
        {
            calls.Add(request.RequestUri!.GetLeftPart(UriPartial.Path));
            if (request.Method == HttpMethod.Post)
            {
                var body = await request.Content!.ReadAsStringAsync(ct);
                check(body.Contains("code=test-code") && request.Headers.Authorization?.Scheme == "Basic", "Sony token exchange sends the code in the POST body with client authentication");
                return Json("{\"access_token\":\"test-access\",\"refresh_token\":\"test-refresh\",\"expires_in\":3600}");
            }
            check(request.RequestUri.AbsolutePath.EndsWith("/test-access") && request.Headers.Authorization?.Scheme == "Basic", "Sony account retrieval uses the exchanged token on the fixed endpoint");
            return Json("{\"user_id\":\"72623859790382856\",\"online_id\":\"Example\"}");
        }));
        var authorization = await new PsnAccountClient(http).AuthorizeAsync("test-code", "test-duid", CancellationToken.None);
        check(authorization.Account.AccountId == "CAcGBQQDAgE=" && !JsonSerializer.Serialize(authorization.Account).Contains("test-access"),
            "account responses contain the ID without exposing Sony tokens");
        check(calls.Count == 2 && calls.All(path => path.StartsWith("https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/token")), "PSN account retrieval only contacts the fixed Sony host");

        var sent = false;
        using var lookupHttp = new HttpClient(new Handler((request, ct) =>
        {
            sent = true;
            check(request.RequestUri!.Host == "psn.flipscreen.games" && request.Headers.Authorization == null, "public lookup uses its fixed provider without forwarding authentication");
            return Task.FromResult(Json("{\"user_id\":72623859790382856,\"online_id\":\"Example\",\"encoded_id\":\"incorrect\"}"));
        }));
        var lookup = new PsnAccountClient(lookupHttp);
        var invalid = false;
        try { await lookup.LookupAsync("../token", CancellationToken.None); } catch (PsnSetupException) { invalid = true; }
        check(invalid && !sent, "invalid online names are rejected before any network request");
        var found = await lookup.LookupAsync("Example", CancellationToken.None);
        check(found.AccountId == "CAcGBQQDAgE=" && !found.CanAutoPair, "public lookup encodes the exact numeric ID and does not grant automatic pairing");
        using var failedHttp = new HttpClient(new Handler((request, ct) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.InternalServerError))));
        var unavailable = false;
        try { await new PsnAccountClient(failedHttp).LookupAsync("Example", CancellationToken.None); }
        catch (PsnSetupException error) { unavailable = error.Status == 503 && error.Message.Contains("PSN sign-in"); }
        check(unavailable, "provider outage offers PSN sign-in or manual account entry");

        var console = new ConsoleInfo("192.168.1.50", "PS5", "112233aabbcc", "PS5");
        using var registration = JsonDocument.Parse("{\"mac\":\"112233aabbcc\",\"rpKey\":\"00112233445566778899aabbccddeeff\",\"registKey\":\"00112233445566778899aabbccddeeff\",\"keyType\":1}");
        check(PsnAutoPairing.Registration(registration.RootElement, console).Success, "pinless registration translates validated keys for the existing streaming backend");
        Rejected(() => PsnAutoPairing.Registration(registration.RootElement, console with { Uuid = "aabbcc112233" }), "pinless pairing cannot bind a different console with the same name");
    }

    private static HttpResponseMessage Json(string body) => new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handle) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => handle(request, cancellationToken);
    }
}
