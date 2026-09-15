namespace RemotePlay.Services.Session;

public sealed class ConsoleHandshakeException(string message) : IOException(message);
