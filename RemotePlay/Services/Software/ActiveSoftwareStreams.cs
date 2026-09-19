using System.Net.WebSockets;
using System.Collections.Concurrent;

namespace RemotePlay.Services.Software;

public sealed class ActiveSoftwareStream(StreamTicket grant, CancellationTokenSource lifetime)
{
    public const string StopReason = "Disconnected by user";
    private readonly TaskCompletionSource closed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int stopRequested;
    public SoftwareInputRouter? Input { private get; set; }
    public bool StopRequested => Volatile.Read(ref stopRequested) != 0;
    public Task Closed => closed.Task;
    public void Complete() => closed.TrySetResult();
    private readonly ConcurrentDictionary<WebSocket, SemaphoreSlim> sockets = new();
    public void Track(WebSocket socket, SemaphoreSlim sendGate) => sockets[socket] = sendGate;
    public async Task RequestStopAsync()
    {
        if (Interlocked.Exchange(ref stopRequested, 1) != 0) return;
        try { await Task.WhenAll(sockets.Select(pair => CloseSocketAsync(pair.Key, pair.Value))); }
        finally
        {
            try { await lifetime.CancelAsync(); }
            catch (ObjectDisposedException) { }
        }
    }
    private static async Task CloseSocketAsync(WebSocket socket, SemaphoreSlim sendGate)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        try
        {
            await sendGate.WaitAsync(timeout.Token);
            try
            {
                if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
                    await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, StopReason, timeout.Token);
            }
            finally { sendGate.Release(); }
        }
        catch (Exception error) when (error is WebSocketException or OperationCanceledException or ObjectDisposedException) { }
    }
    public Guid Id { get; } = Guid.NewGuid();
    public StreamTicket Grant { get; } = grant;
    public DateTimeOffset StartedAt { get; } = DateTimeOffset.UtcNow;
    public StreamTelemetry Telemetry { get; } = new();
    private long rumblePackets;
    /// <summary>Rumble packets the console sent this session; tells "the game never rumbled" from "the pad did not vibrate".</summary>
    public long RumblePackets => Interlocked.Read(ref rumblePackets);
    public void CountRumble() => Interlocked.Increment(ref rumblePackets);
    private long videoSkipped;
    /// <summary>Video units the server gave up because the WebRTC channel's send buffer was backed up.</summary>
    public long VideoSkipped { get => Interlocked.Read(ref videoSkipped); set => Interlocked.Exchange(ref videoSkipped, value); }
    private readonly SemaphoreSlim clients = new(4, 4);
    public int InputClients => 4 - clients.CurrentCount;
    public bool IsOpen => Input != null && !StopRequested && !lifetime.IsCancellationRequested;

    public bool TryAttach() => IsOpen && clients.Wait(0);
    public void Detach() => clients.Release();

    public async Task ReceiveAsync(WebSocket socket, CancellationToken aborted)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token, aborted);
        using var sendGate = new SemaphoreSlim(1, 1);
        Track(socket, sendGate);
        try { if (Input != null && !StopRequested) await Input.ReceiveAsync(socket, linked.Token, acknowledge: true, sendGate: sendGate); }
        catch (Exception ex) when (ex is IOException or System.Text.Json.JsonException or WebSocketException or OperationCanceledException) { }
        finally
        {
            sockets.TryRemove(socket, out _);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            try { await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, StopRequested ? StopReason : "Input detached", timeout.Token); }
            catch (Exception ex) when (ex is WebSocketException or OperationCanceledException) { }
        }
    }
}

public sealed class ActiveSoftwareStreams
{
    private ActiveSoftwareStream? current;
    public void Set(ActiveSoftwareStream stream) => Interlocked.Exchange(ref current, stream);
    public ActiveSoftwareStream? Current => Volatile.Read(ref current);
    public bool Any => Volatile.Read(ref current) is { IsOpen: true };
    public void Remove(ActiveSoftwareStream stream) => Interlocked.CompareExchange(ref current, null, stream);
    public async Task<bool> StopConsoleAsync(string hostId, CancellationToken ct)
    {
        var stream = Volatile.Read(ref current);
        if (stream == null || stream.Grant.HostId != hostId) return false;
        await stream.RequestStopAsync();
        await stream.Closed.WaitAsync(ct);
        return true;
    }
    public ActiveSoftwareStream? Find(string userId, Guid? id = null)
    {
        var stream = Volatile.Read(ref current);
        return stream is { IsOpen: true } && stream.Grant.UserId == userId && (id == null || stream.Id == id) ? stream : null;
    }
}
