using RemotePlay.Services.Software;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;

static class SessionCleanupTests
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        var tickets = new StreamTickets(TimeProvider.System);
        var owner = tickets.Issue("alice", "ps5", false, 10000);
        var otherViewer = tickets.Issue("bob", "ps5", false, 10000);
        var anotherConsole = tickets.Issue("alice", "ps4", false, 10000);
        tickets.RevokeConsole("ps5");
        check(tickets.Consume(owner) == null && tickets.Consume(otherViewer) == null && tickets.Consume(anotherConsole) != null, "disconnect revokes all pending tickets for only the selected console");
        using var lifetime = new CancellationTokenSource();
        var grant = new StreamTicket("alice", "ps5", false, 10000, DateTimeOffset.UtcNow.AddMinutes(1));
        var stream = new ActiveSoftwareStream(grant, lifetime);
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        using var browserConnection = new TcpClient();
        await browserConnection.ConnectAsync(IPAddress.Loopback, ((IPEndPoint)listener.LocalEndpoint).Port);
        using var serverConnection = await listener.AcceptTcpClientAsync();
        using var browserSocket = WebSocket.CreateFromStream(browserConnection.GetStream(), false, null, TimeSpan.Zero);
        using var serverSocket = WebSocket.CreateFromStream(serverConnection.GetStream(), true, null, TimeSpan.Zero);
        using var sendGate = new SemaphoreSlim(1, 1);
        stream.Track(serverSocket, sendGate);
        var active = new ActiveSoftwareStreams();
        active.Set(stream);
        check(active.Find("alice") == null, "a connecting session cannot accept input attachments yet");
        check(!await active.StopConsoleAsync("ps4", CancellationToken.None) && !lifetime.IsCancellationRequested, "disconnecting another console preserves the connecting session");
        var stop = active.StopConsoleAsync("ps5", CancellationToken.None);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        var close = await browserSocket.ReceiveAsync(new ArraySegment<byte>(new byte[256]), timeout.Token);
        check(close.MessageType == WebSocketMessageType.Close && browserSocket.CloseStatusDescription == ActiveSoftwareStream.StopReason,
            "forced disconnect delivers its close reason over a real socket before cancellation");
        for (var i = 0; i < 100 && !lifetime.IsCancellationRequested; i++) await Task.Delay(10);
        check(lifetime.IsCancellationRequested && stream.StopRequested && !stop.IsCompleted, "connecting sessions can be stopped and cleanup must finish before acknowledging");
        active.Remove(stream);
        stream.Complete();
        check(await stop && active.Find("alice") == null, "completed session cleanup releases its registry entry");
    }
}
