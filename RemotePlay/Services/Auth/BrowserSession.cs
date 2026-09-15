namespace RemotePlay.Services.Auth;

public static class BrowserSession
{
    public const string CookieName = "remote-play-session";

    public static bool IsSameOrigin(HttpRequest request) =>
        request.Headers["X-Remote-Play-Session"] == "1" && HasSameOrigin(request);

    public static bool CanPersistLogin(HttpRequest request) => HasSameOrigin(request) &&
        (request.Headers["X-Remote-Play-Session"] == "1" || request.Headers.Origin.Count > 0 ||
         request.Headers["Sec-Fetch-Site"] == "same-origin");

    private static bool HasSameOrigin(HttpRequest request)
    {
        var site = request.Headers["Sec-Fetch-Site"].ToString();
        if (site.Length > 0 && site is not "same-origin" and not "none") return false;
        var origin = request.Headers.Origin.ToString();
        return origin.Length == 0 || (Uri.TryCreate(origin, UriKind.Absolute, out var uri) &&
            uri.Scheme is "http" or "https" &&
            string.Equals(uri.Authority, request.Host.Value, StringComparison.OrdinalIgnoreCase));
    }

    public static CookieOptions Options(HttpRequest request, DateTimeOffset? expires = null) => new()
    {
        HttpOnly = true,
        SameSite = SameSiteMode.Strict,
        Secure = request.IsHttps || (Uri.TryCreate(request.Headers.Origin, UriKind.Absolute, out var origin) && origin.Scheme == "https"),
        Path = "/api/auth",
        Expires = expires,
        IsEssential = true
    };
}
