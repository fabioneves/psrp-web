using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using RemotePlay.Services;

namespace RemotePlay.Controllers;

[ApiController, Authorize, Route("api/version")]
public sealed class VersionController(UpdateCheck updates) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        Response.Headers.CacheControl = "no-store";
        var status = await updates.GetAsync(ct);
        return Ok(new { version = status.Version, latest = status.Latest, updateAvailable = status.UpdateAvailable, checkedAt = status.CheckedAt });
    }
}
