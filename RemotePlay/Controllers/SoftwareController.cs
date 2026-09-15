using System.ComponentModel.DataAnnotations;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using RemotePlay.Models.Context;
using RemotePlay.Services.Software;

namespace RemotePlay.Controllers;

[ApiController, Authorize, Route("api/software")]
public sealed class SoftwareController(StreamTickets tickets, RPContext db, SoftwareSession runner, ActiveSoftwareStreams active, ConsolePower power,
    RemotePlay.Contracts.Services.ISessionService sessions, RemotePlay.Contracts.Services.IStreamingService streams) : ControllerBase
{
    [HttpPost("disconnect")]
    public async Task<IActionResult> Disconnect(WakeRequest request, CancellationToken ct)
    {
        Response.Headers.CacheControl = "no-store";
        var device = await power.FindAsync(User.FindFirstValue(ClaimTypes.NameIdentifier)!, request.HostId, ct);
        if (device == null) return NotFound(new { message = "Pair this console with your account first." });
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        tickets.RevokeConsole(request.HostId);
        try
        {
            var stopped = await active.StopConsoleAsync(request.HostId, timeout.Token) ? 1 : 0;
            foreach (var session in (await sessions.ListSessionsAsync(timeout.Token)).Where(session => session.HostId == device.HostId))
            {
                try { await streams.StopStreamAsync(session.Id, timeout.Token); }
                finally { await sessions.StopSessionAsync(session.Id, timeout.Token); }
                stopped++;
            }
            return Ok(new { stopped, message = "All sessions opened by this server for this console are disconnected." });
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return StatusCode(504, new { message = "Session cleanup is still running. Wait a moment and try again." });
        }
    }

    [HttpPost("sleep")]
    public async Task<IActionResult> Sleep(WakeRequest request, CancellationToken ct)
    {
        Response.Headers.CacheControl = "no-store";
        var device = await power.FindAsync(User.FindFirstValue(ClaimTypes.NameIdentifier)!, request.HostId, ct);
        if (device == null) return NotFound(new { message = "Pair this console with your account first." });
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(25));
        var ownsViewer = false;
        try
        {
            var existing = (await sessions.ListSessionsAsync(timeout.Token)).FirstOrDefault(session => session.HostId == request.HostId);
            if (existing != null)
            {
                if (!await sessions.WaitReadyAsync(existing.Id, TimeSpan.FromSeconds(10), timeout.Token) ||
                    !await sessions.StandbyAsync(existing.Id, timeout.Token))
                    return Conflict(new { message = "The console session ended. Try again from your console list." });
                tickets.RevokeConsole(request.HostId);
                if (!await active.StopConsoleAsync(request.HostId, timeout.Token))
                {
                    try { await streams.StopStreamAsync(existing.Id, timeout.Token); }
                    finally { await sessions.StopSessionAsync(existing.Id, timeout.Token); }
                }
            }
            else
            {
                ownsViewer = await tickets.Viewer.WaitAsync(TimeSpan.FromSeconds(3), timeout.Token);
                if (!ownsViewer) return Conflict(new { message = "A stream is starting or still active. Wait for it to connect, then choose Put console to sleep." });
                tickets.RevokeConsole(request.HostId);
                await power.SleepIdleAsync(device, sessions, timeout.Token);
            }
            return Ok(new { message = "Rest mode requested. The console may take a moment to go to sleep." });
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return StatusCode(504, new { message = "The rest-mode request timed out. Refresh the console list before trying again." });
        }
        catch (IOException error) { return Conflict(new { message = error.Message }); }
        finally { if (ownsViewer) tickets.Viewer.Release(); }
    }

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
        if (!request.Demo && request.InputSession == null && request.VideoCodec == "h265" &&
            !await db.UserDevices.AnyAsync(d => d.UserId == userId && d.IsActive && d.Device != null &&
                d.Device.HostId == request.HostId && d.Device.HostType == "PS5", ct))
            return BadRequest(new { message = "H.265 requires a PS5. Select H.264 or Canvas for this console." });
        if (request.InputSession == null)
        {
            if (!await tickets.Viewer.WaitAsync(TimeSpan.FromSeconds(8), ct))
                return Conflict(new { message = "Another stream is still active on this server. Disconnect that stream before trying again." });
            tickets.Viewer.Release();
        }
        var ticket = tickets.Issue(userId, request.HostId, request.Demo, request.BitrateKbps, request.InputSession, request.Resolution, request.Fps, request.VideoCodec);
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
        if (!await tickets.Viewer.WaitAsync(TimeSpan.FromSeconds(8), ct))
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
    Guid? InputSession = null, string Resolution = "720p", int Fps = 60,
    [Required, RegularExpression("^(mpeg1|h264|h265)$")] string VideoCodec = "mpeg1");

public sealed record WakeRequest([Required, MaxLength(100)] string HostId);
