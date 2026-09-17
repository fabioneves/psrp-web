using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using RemotePlay.Services;

namespace RemotePlay.Controllers;

[ApiController, Authorize, Route("api/diagnostics")]
public sealed class DiagnosticsController(DiagnosticsStore store, TimeProvider clock) : ControllerBase
{
    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpGet]
    public IActionResult List()
    {
        Response.Headers.CacheControl = "no-store";
        return Ok(store.List(UserId).Select(entry => new { entry.Name, entry.Bytes, entry.SavedAt }));
    }

    [HttpPost]
    public async Task<IActionResult> Save([FromBody] JsonElement capture, CancellationToken ct)
    {
        try
        {
            var entry = await store.SaveAsync(UserId, capture, clock.GetUtcNow(), ct);
            return Ok(new { entry.Name, entry.Bytes, entry.SavedAt });
        }
        catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
    }

    [HttpGet("{name}")]
    public IActionResult Get(string name)
    {
        var path = store.PathOf(UserId, name);
        if (path == null) return NotFound(new { message = "No such diagnostics capture." });
        Response.Headers.CacheControl = "no-store";
        return PhysicalFile(path, "application/json", name);
    }
}
