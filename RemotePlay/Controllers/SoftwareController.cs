using System.ComponentModel.DataAnnotations;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using RemotePlay.Models.Context;
using RemotePlay.Services.Software;

namespace RemotePlay.Controllers;

[ApiController, Authorize, Route("api/software")]
public sealed class SoftwareController(StreamTickets tickets, RPContext db, SoftwareSession runner, ActiveSoftwareStreams active, ConsolePower power) : ControllerBase
{
    [HttpPost("wake")]
    public async Task<IActionResult> Wake(WakeRequest request, CancellationToken ct)
    {
        Response.Headers.CacheControl = "no-store";
        var device = await power.FindAsync(User.FindFirstValue(ClaimTypes.NameIdentifier)!, request.HostId, ct);
        if (device == null) return NotFound(new { message = "Pair this console with your account first." });
        try
        {
            await power.EnsureReadyAsync(device, _ => Task.CompletedTask, ct);
            return Ok(new { hostId = device.HostId, status = device.Status });
        }
        catch (TimeoutException error) { return StatusCode(504, new { message = error.Message }); }
        catch (IOException error) { return StatusCode(409, new { message = error.Message }); }
    }

    [HttpPost("tickets")]
    public async Task<IActionResult> Ticket(StreamRequest request, CancellationToken ct)
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier)!;
        VideoProfile.Create(request.Resolution, request.Fps);
        if (request.InputSession is { } session)
        {
            if (active.Find(userId, session) == null) return NotFound(new { message = "This stream is no longer running on your account." });
        }
        else if (!request.Demo && !await db.UserDevices.AnyAsync(d => d.UserId == userId && d.IsActive &&
                d.Device != null && d.Device.HostId == request.HostId && d.Device.IsRegistered == true, ct))
            return NotFound(new { message = "Pair this console with your account first." });
        var ticket = tickets.Issue(userId, request.HostId, request.Demo, request.BitrateKbps, request.InputSession, request.Resolution, request.Fps);
        Response.Headers.CacheControl = "no-store";
        return Ok(new { ticket });
    }

    [HttpGet("active")]
    public IActionResult Active()
    {
        Response.Headers.CacheControl = "no-store";
        var stream = active.Find(User.FindFirstValue(ClaimTypes.NameIdentifier)!);
        return new JsonResult(stream == null ? null : new { sessionId = stream.Id, stream.Grant.HostId,
            stream.Grant.Demo, stream.InputClients });
    }

    [AllowAnonymous, HttpGet("stream")]
    public async Task Stream([FromQuery] string ticket, CancellationToken ct)
    {
        if (!HttpContext.WebSockets.IsWebSocketRequest)
        {
            Response.StatusCode = 400;
            return;
        }
        var grant = tickets.Consume(ticket);
        if (grant == null)
        {
            Response.StatusCode = 401;
            return;
        }
        if (grant.InputSession is { } inputSession)
        {
            var stream = active.Find(grant.UserId, inputSession);
            if (stream == null || !stream.TryAttach()) { Response.StatusCode = 409; return; }
            try
            {
                using var socket = await HttpContext.WebSockets.AcceptWebSocketAsync();
                await stream.ReceiveAsync(socket, ct);
            }
            finally { stream.Detach(); }
            return;
        }
        if (!await tickets.Viewer.WaitAsync(0, ct))
        {
            Response.StatusCode = 409;
            return;
        }
        try
        {
            using var socket = await HttpContext.WebSockets.AcceptWebSocketAsync();
            await runner.RunAsync(socket, grant, ct);
        }
        finally { tickets.Viewer.Release(); }
    }
}

public sealed record StreamRequest(string? HostId, bool Demo = false, [Range(2000, 30000)] int BitrateKbps = 10000,
    Guid? InputSession = null, string Resolution = "720p", int Fps = 60);

public sealed record WakeRequest([Required, MaxLength(100)] string HostId);
