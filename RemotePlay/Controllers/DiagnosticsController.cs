using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using RemotePlay.Services;
using RemotePlay.Services.Software;

namespace RemotePlay.Controllers;

[ApiController, Authorize, Route("api/diagnostics")]
public sealed class DiagnosticsController(DiagnosticsStore store, TimeProvider clock, ActiveSoftwareStreams active) : ControllerBase
{
    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    /// <summary>The running stream's live telemetry (any signed-in user of this single-viewer server), or 404 when none is streaming.</summary>
    [HttpGet("live")]
    public IActionResult Live()
    {
        Response.Headers.CacheControl = "no-store";
        var stream = active.Current;
        if (stream == null || !stream.IsOpen) return NotFound(new { message = "No stream is running." });
        var (samples, events, received, lastAt) = stream.Telemetry.Snapshot();
        return Ok(new { stream.Id, stream.Grant.HostId, stream.Grant.Demo, stream.StartedAt, received, lastAt, samples, events,
            hint = received == 0 ? "Enable \"Stream live telemetry to the server\" under the debug HUD in the player." : null });
    }

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
