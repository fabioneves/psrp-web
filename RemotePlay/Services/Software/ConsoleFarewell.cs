namespace RemotePlay.Services.Software;

/// <summary>
/// The console frees a Remote Play session within seconds when it is told the client left, and only after a minute or two
/// when it is not. The goodbye travels on the console stream, so a session that ends while still starting (the browser
/// reloaded, changed a setting, lost its connection) has nothing to say it on. This finishes that start, on its own clock
/// because the session's has already been cancelled, so the normal stop can say goodbye.
/// </summary>
public static class ConsoleFarewell
{
    /// <returns>The started stream, negotiated or not, or null when there is none to stop.</returns>
    public static async Task<T?> FinishStartAsync<T>(Func<CancellationToken, Task<bool>> waitReady, Func<CancellationToken, Task<T?>> startStream,
        Func<T, bool> negotiated, TimeSpan limit) where T : class
    {
        using var deadline = new CancellationTokenSource(limit);
        try
        {
            if (!await waitReady(deadline.Token)) return null;
            var stream = await startStream(deadline.Token);
            while (stream != null && !negotiated(stream) && !deadline.IsCancellationRequested)
                await Task.Delay(50, deadline.Token).ContinueWith(_ => { }, TaskScheduler.Default);
            return stream;
        }
        catch (Exception) { return null; }
    }
}
