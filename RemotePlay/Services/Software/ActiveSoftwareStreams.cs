using System.Net.WebSockets;

namespace RemotePlay.Services.Software;

public sealed class ActiveSoftwareStream(StreamTicket grant, SoftwareInputRouter input, CancellationToken lifetime)
{
    public Guid Id { get; } = Guid.NewGuid();
    public StreamTicket Grant { get; } = grant;
    private readonly SemaphoreSlim clients = new(4, 4);
    public int InputClients => 4 - clients.CurrentCount;
    public bool IsOpen => !lifetime.IsCancellationRequested;

    public bool TryAttach() => IsOpen && clients.Wait(0);
    public void Detach() => clients.Release();

    public async Task ReceiveAsync(WebSocket socket, CancellationToken aborted)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(lifetime, aborted);
        try { await input.ReceiveAsync(socket, linked.Token, acknowledge: true); }
        catch (Exception ex) when (ex is IOException or System.Text.Json.JsonException or WebSocketException or OperationCanceledException) { }
        finally
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            try { await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "Input detached", timeout.Token); }
            catch (Exception ex) when (ex is WebSocketException or OperationCanceledException) { }
        }
    }
}

public sealed class ActiveSoftwareStreams
{
    private ActiveSoftwareStream? current;
    public void Set(ActiveSoftwareStream stream) => Interlocked.Exchange(ref current, stream);
    public void Remove(ActiveSoftwareStream stream) => Interlocked.CompareExchange(ref current, null, stream);
    public ActiveSoftwareStream? Find(string userId, Guid? id = null)
    {
        var stream = Volatile.Read(ref current);
        return stream is { IsOpen: true } && stream.Grant.UserId == userId && (id == null || stream.Id == id) ? stream : null;
    }
}
