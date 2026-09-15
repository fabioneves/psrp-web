using System.Net;
using System.Net.Sockets;
using RemotePlay.Services.Session;

static class ConsoleSocketTests
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        var pending = ConsoleSocket.ConnectAsync("127.0.0.1", port, timeout.Token);
        try
        {
            await Task.Delay(100, timeout.Token);
            check(!pending.IsCompleted, "console connection waits through a temporarily refused socket");
            listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            using var accepted = await listener.AcceptTcpClientAsync(timeout.Token);
            using var connected = await pending;
            check(connected.Connected && connected.NoDelay, "console connection retries successfully with TCP batching disabled");
        }
        finally { listener.Stop(); }
        using var cancelled = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));
        var stopped = false;
        try { using var connection = await ConsoleSocket.ConnectAsync("127.0.0.1", port, cancelled.Token); }
        catch (OperationCanceledException) { stopped = true; }
        check(stopped, "cancelling playback stops pending console connection retries");
    }
}
