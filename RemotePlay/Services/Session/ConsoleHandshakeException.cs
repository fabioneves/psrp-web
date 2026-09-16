namespace RemotePlay.Services.Session;

public sealed class ConsoleHandshakeException(string message, bool consoleBusy = false) : IOException(message)
{
    /// <summary>The console still holds a previous Remote Play session (reason 80108b10); retrying shortly usually succeeds.</summary>
    public bool ConsoleBusy { get; } = consoleBusy;
}
