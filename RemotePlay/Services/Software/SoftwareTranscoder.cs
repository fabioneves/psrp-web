using System.Diagnostics;
using System.Net.WebSockets;

namespace RemotePlay.Services.Software;

public sealed class SoftwareTranscoder : IDisposable
{
    private readonly Process process;
    private readonly Task<string> errors;

    public SoftwareTranscoder(int bitrateKbps)
    {
        process = Start(BuildArguments(bitrateKbps));
        errors = ReadErrorsAsync();
    }

    public static string[] BuildArguments(int bitrateKbps)
    {
        if (bitrateKbps is < 2000 or > 20000) throw new ArgumentOutOfRangeException(nameof(bitrateKbps));
        return ["-hide_banner", "-loglevel", "error", "-hwaccel", "none", "-threads", "2",
            "-fflags", "+nobuffer", "-flags", "low_delay", "-probesize", "32768", "-analyzeduration", "0",
            "-f", "h264", "-r", "60", "-i", "pipe:0", "-an", "-sn", "-dn",
            "-vf", "scale=1280:720:flags=fast_bilinear", "-c:v", "mpeg1video", "-threads", "2",
            "-r", "60", "-b:v", $"{bitrateKbps}k", "-maxrate", $"{bitrateKbps}k", "-bufsize", $"{bitrateKbps}k",
            "-bf", "0", "-g", "15", "-pix_fmt", "yuv420p", "-f", "mpegts",
            "-muxdelay", "0", "-muxpreload", "0", "-flush_packets", "1", "pipe:1"];
    }

    public static Process Start(IEnumerable<string> arguments)
    {
        var info = new ProcessStartInfo("ffmpeg")
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        return Process.Start(info) ?? throw new IOException("Could not start FFmpeg.");
    }

    public async Task FeedAsync(SoftwareReceiver receiver, CancellationToken ct)
    {
        await foreach (var packet in receiver.Packets.ReadAllAsync(ct))
            await process.StandardInput.BaseStream.WriteAsync(packet, ct);
    }

    public Task FeedAsync(Stream source, CancellationToken ct) => source.CopyToAsync(process.StandardInput.BaseStream, ct);

    private async Task<string> ReadErrorsAsync()
    {
        var recent = "";
        var buffer = new char[1024];
        int count;
        while ((count = await process.StandardError.ReadAsync(buffer)) > 0)
        {
            recent += new string(buffer, 0, count);
            if (recent.Length > 4096) recent = recent[^4096..];
        }
        return recent;
    }

    public async Task SendAsync(WebSocket socket, CancellationToken ct)
    {
        var buffer = new byte[188 * 64];
        while (true)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            var count = await process.StandardOutput.BaseStream.ReadAsync(buffer, timeout.Token);
            if (count == 0) throw new IOException($"FFmpeg stopped: {await errors}");
            timeout.CancelAfter(TimeSpan.FromSeconds(1));
            await socket.SendAsync(buffer.AsMemory(0, count), WebSocketMessageType.Binary, true, timeout.Token);
        }
    }

    public void Dispose()
    {
        if (!process.HasExited) process.Kill(entireProcessTree: true);
        process.WaitForExit(3000);
        process.Dispose();
    }
}
