using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using RemotePlay.Services.Auth;

namespace RemotePlay.Controllers;

[ApiController, Authorize, Route("api/settings")]
public sealed class SettingsController(UserSettingsStore store) : ControllerBase
{
    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    /// <summary>The account's saved player settings, or null when this account has never saved any.</summary>
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        Response.Headers.CacheControl = "no-store";
        var raw = await store.ReadAsync(UserId, ct);
        return Content(raw == null ? "{\"settings\":null}" : "{\"settings\":" + raw + "}", "application/json");
    }

    [HttpPut]
    public async Task<IActionResult> Put([FromBody] JsonElement settings, CancellationToken ct)
    {
        if (UserSettingsStore.Validate(settings) is { } problem) return BadRequest(new { message = problem });
        await store.SaveAsync(UserId, settings, ct);
        return NoContent();
    }
}
