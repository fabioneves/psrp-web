using System.Security.Cryptography;

namespace RemotePlay.Services.Software;

public sealed record StreamTicket(string UserId, string? HostId, bool Demo, int BitrateKbps, DateTimeOffset Expires,
    Guid? InputSession = null, string Resolution = "720p", int Fps = 60, string VideoCodec = "mpeg1");

public sealed class StreamTickets(TimeProvider clock)
{
    private readonly Dictionary<string, StreamTicket> tickets = [];
    private readonly object sync = new();
    public SemaphoreSlim Viewer { get; } = new(1, 1);

    public string Issue(string userId, string? hostId, bool demo, int bitrateKbps, Guid? inputSession = null,
        string resolution = "720p", int fps = 60, string videoCodec = "mpeg1")
    {
        if (videoCodec is not ("mpeg1" or "h264")) throw new ArgumentOutOfRangeException(nameof(videoCodec));
        lock (sync)
        {
            foreach (var key in tickets.Where(p => p.Value.Expires <= clock.GetUtcNow()).Select(p => p.Key).ToArray())
                tickets.Remove(key);
            if (tickets.Count >= 64) throw new InvalidOperationException("Too many pending stream requests. Try again in 30 seconds.");
            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            tickets[token] = new(userId, hostId, demo, bitrateKbps, clock.GetUtcNow().AddSeconds(30), inputSession, resolution, fps, videoCodec);
            return token;
        }
    }

    public StreamTicket? Consume(string token)
    {
        lock (sync)
            return tickets.Remove(token, out var ticket) && ticket.Expires > clock.GetUtcNow() ? ticket : null;
    }
}
