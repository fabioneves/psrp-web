using System.ComponentModel.DataAnnotations;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using RemotePlay.Services.Auth;

namespace RemotePlay.Controllers;

[ApiController, Authorize, Route("api/psn")]
public sealed class PsnController(PsnAccountClient client, PsnLoginAttempts attempts, PsnAccountStore store, PsnAutoPairing pairing) : ControllerBase
{
    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpPost("pair")]
    public Task<IActionResult> Pair(PsnPair request, CancellationToken ct) => ExecuteAsync(async () => Ok(await pairing.PairAsync(UserId, request.HostIp.Trim(), ct)), ct);

    [HttpPost("login")]
    public Task<IActionResult> Login(CancellationToken ct) => ExecuteAsync(() => Task.FromResult<IActionResult>(Ok(new { loginUrl = attempts.Start(UserId) })), ct);

    [HttpGet("account")]
    public Task<IActionResult> Account(CancellationToken ct) => ExecuteAsync(async () => Ok(new { account = await store.AccountAsync(UserId, ct) }), ct);

    [HttpDelete("account")]
    public Task<IActionResult> Clear(CancellationToken ct) => ExecuteAsync(async () => { await store.ClearAsync(UserId, ct); return Ok(new { success = true }); }, ct);

    [HttpPost("account")]
    public Task<IActionResult> Complete(PsnRedirect request, CancellationToken ct) => ExecuteAsync(async () =>
    {
        var (code, duid) = attempts.Consume(UserId, request.RedirectUrl.Trim());
        var authorization = await client.AuthorizeAsync(code, duid, ct);
        await store.SaveAsync(UserId, authorization.Account, authorization.Tokens, ct);
        return Ok(authorization.Account);
    }, ct);

    [HttpPost("lookup")]
    public Task<IActionResult> Lookup(PsnLookup request, CancellationToken ct) => ExecuteAsync(async () =>
    {
        var account = await client.LookupAsync(request.OnlineId.Trim(), ct);
        await store.SaveAsync(UserId, account, null, ct);
        return Ok(account);
    }, ct);

    private async Task<IActionResult> ExecuteAsync(Func<Task<IActionResult>> action, CancellationToken ct)
    {
        Response.Headers.CacheControl = "no-store";
        try { return await action(); }
        catch (PsnSetupException error) { return StatusCode(error.Status, new { message = error.Message }); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return StatusCode(504, new { message = "The account service timed out. Please try again." }); }
        catch (HttpRequestException) { return StatusCode(503, new { message = "The account service could not be reached. Please try again or enter your account ID manually." }); }
        catch (JsonException) { return StatusCode(502, new { message = "The account service returned an invalid response. Please try again or enter your account ID manually." }); }
    }
}

public sealed record PsnRedirect([Required, MaxLength(4096)] string RedirectUrl);
public sealed record PsnLookup([Required, MaxLength(16)] string OnlineId);
public sealed record PsnPair([Required, MaxLength(45)] string HostIp);
