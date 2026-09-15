using System.Net.Sockets;

namespace RemotePlay.Services.Session;

public static class ConsoleSocket
{
    public static async Task<TcpClient> ConnectAsync(string host, int port, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(8));
        try
        {
            while (true)
            {
                deadline.Token.ThrowIfCancellationRequested();
                var client = new TcpClient { NoDelay = true };
                try { await client.ConnectAsync(host, port, deadline.Token); return client; }
                catch (SocketException error) when (error.SocketErrorCode == SocketError.ConnectionRefused) { client.Dispose(); }
                catch { client.Dispose(); throw; }
                await Task.Delay(250, deadline.Token);
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new TimeoutException("The console is awake but its Remote Play service is not ready. Check that Remote Play is enabled and try again.");
        }
    }
}
