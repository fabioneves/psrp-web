using System.Diagnostics;
using System.Net.WebSockets;

namespace RemotePlay.Services.Software;

public sealed class SoftwareTranscoder : IDisposable
{
    private readonly Process process;
    private readonly Task<string> errors;

    public SoftwareTranscoder(int bitrateKbps, string resolution = "720p", int fps = 60, string videoCodec = "mpeg1")
    {
        process = Start(BuildArguments(bitrateKbps, resolution, fps, videoCodec));
        errors = ReadErrorsAsync();
    }

    public static string[] BuildArguments(int bitrateKbps, string resolution = "720p", int fps = 60, string videoCodec = "mpeg1")
    {
        if (bitrateKbps is < 2000 or > 30000) throw new ArgumentOutOfRangeException(nameof(bitrateKbps));
        var profile = VideoProfile.Create(resolution, fps);
        if (videoCodec is not ("mpeg1" or "h264" or "h265")) throw new ArgumentOutOfRangeException(nameof(videoCodec));
        if (videoCodec != "mpeg1")
            return ["-hide_banner", "-loglevel", "error", "-probesize", "32768", "-analyzeduration", "0",
                "-f", videoCodec == "h265" ? "hevc" : "h264", "-r", profile.Fps.ToString(), "-i", "pipe:0", "-an", "-sn", "-dn",
                "-c:v", "copy", "-f", "mpegts", "-mpegts_flags", "resend_headers", "-omit_video_pes_length", "0",
                "-muxdelay", "0", "-muxpreload", "0", "-flush_packets", "1", "pipe:1"];
        var threads = int.TryParse(Environment.GetEnvironmentVariable("ENCODER_THREADS"), out var configured)
            ? Math.Clamp(configured, 1, 16).ToString() : "4";
        var decoderThreads = int.TryParse(Environment.GetEnvironmentVariable("DECODER_THREADS"), out var decoded)
            ? Math.Clamp(decoded, 1, 16).ToString() : "1";
        return ["-hide_banner", "-loglevel", "error", "-hwaccel", "none", "-threads", decoderThreads,
            "-flags", "low_delay", "-probesize", "32768", "-analyzeduration", "0",
            "-f", "h264", "-r", profile.Fps.ToString(), "-i", "pipe:0", "-an", "-sn", "-dn",
            "-vf", $"scale={profile.Width}:{profile.Height}:flags=fast_bilinear", "-c:v", "mpeg1video", "-threads", threads,
            "-r", profile.Fps.ToString(), "-b:v", $"{bitrateKbps}k", "-maxrate", $"{bitrateKbps}k", "-bufsize", $"{bitrateKbps}k",
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

    public async Task SendAsync(WebSocket socket, CancellationToken ct, SemaphoreSlim? sendGate = null)
    {
        var buffer = new byte[MediaPacket.HeaderSize + 188 * 64];
        while (true)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            var count = await process.StandardOutput.BaseStream.ReadAsync(buffer.AsMemory(MediaPacket.HeaderSize), timeout.Token);
            if (count == 0) throw new IOException($"FFmpeg stopped: {await errors}");
            var ready = MediaPacket.Now;
            timeout.CancelAfter(TimeSpan.FromSeconds(1));
            if (sendGate != null) await sendGate.WaitAsync(timeout.Token);
            try
            {
                MediaPacket.Stamp(buffer, 1, ready, ready);
                await socket.SendAsync(buffer.AsMemory(0, count + MediaPacket.HeaderSize), WebSocketMessageType.Binary, true, timeout.Token);
            }
            finally { sendGate?.Release(); }
        }
    }

    public void Dispose()
    {
        if (!process.HasExited) process.Kill(entireProcessTree: true);
        process.WaitForExit(3000);
        process.Dispose();
    }
}
