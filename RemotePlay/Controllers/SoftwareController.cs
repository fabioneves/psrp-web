using System.ComponentModel.DataAnnotations;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using RemotePlay.Models.Context;
using RemotePlay.Services.Software;

namespace RemotePlay.Controllers;

[ApiController, Authorize, Route("api/software")]
public sealed class SoftwareController(StreamTickets tickets, RPContext db, SoftwareSession runner) : ControllerBase
{
    [HttpPost("tickets")]
    public async Task<IActionResult> Ticket(StreamRequest request, CancellationToken ct)
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier)!;
        if (!request.Demo && !await db.UserDevices.AnyAsync(d => d.UserId == userId && d.IsActive &&
                d.Device != null && d.Device.HostId == request.HostId && d.Device.IsRegistered == true, ct))
            return NotFound(new { message = "Pair this console with your account first." });
        var ticket = tickets.Issue(userId, request.HostId, request.Demo, request.BitrateKbps);
        Response.Headers.CacheControl = "no-store";
        return Ok(new { ticket });
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

public sealed record StreamRequest(string? HostId, bool Demo = false, [Range(2000, 20000)] int BitrateKbps = 10000);
