using System.Diagnostics;
using System.Text.Json;
using RemotePlay.Models.PlayStation;
using RemotePlay.Services.Software;
using RemotePlay.Services.Streaming.Launch;

static class HevcTests
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        var launch = StreamLaunchOptionsResolver.Resolve(new RemoteSession { StreamType = "2", Resolution = "1080p", Fps = "60" });
        check(launch.VideoCodec == "hevc" && !launch.Hdr && launch.Width == 1920 && launch.Fps == 60, "HEVC selection negotiates SDR PS5 video at the selected profile");
        var tickets = new StreamTickets(TimeProvider.System);
        check(tickets.Consume(tickets.Issue("test", null, true, 10000, videoCodec: "h265"))?.VideoCodec == "h265", "HEVC survives the single-use stream ticket");
        using var receiver = new SoftwareReceiver(32, "hevc");
        receiver.SetVideoCodec("hevc");
        receiver.OnStreamInfo([0, 0, 0, 1, 0x40, 1], []);
        receiver.OnVideoPacket([2, 0, 0, 1, 2, 1, 9]);
        check(!receiver.Packets.TryRead(out _) && receiver.FramesReceived == 1, "HEVC delta pictures wait for random access but still count as console frames");
        receiver.OnVideoPacket([2, 0, 0, 0, 1, 0x26, 1, 9]);
        check(receiver.Packets.TryRead(out var header) && header.Data[4] == 0x40 && receiver.Packets.TryRead(out var frame) && frame.Data[4] == 0x26, "HEVC IDR is delivered after VPS/SPS/PPS headers");
        check(SoftwareReceiver.ContainsIdr([0, 0, 1, 0x2a, 1], "hevc") && !SoftwareReceiver.ContainsIdr([0, 0, 1, 0x26], "hevc"), "HEVC CRA is accepted and truncated NAL headers are rejected");
        using var source = SoftwareTranscoder.Start(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=60",
            "-frames:v", "6", "-c:v", "libx265", "-preset", "ultrafast", "-tune", "zerolatency",
            "-x265-params", "pools=1:frame-threads=1:log-level=error:aud=1", "-f", "hevc", "pipe:1"]);
        var sourceErrors = source.StandardError.ReadToEndAsync();
        using var raw = new MemoryStream();
        await source.StandardOutput.BaseStream.CopyToAsync(raw);
        await source.WaitForExitAsync();
        check(source.ExitCode == 0, "real HEVC test encoder succeeds: " + await sourceErrors);
        using var encodedReceiver = new SoftwareReceiver(32, "hevc");
        raw.Position = 0;
        await AccessUnitSplitter.PumpAsync(raw, encodedReceiver, "h265", CancellationToken.None);
        using var transport = new MemoryStream();
        var units = 0;
        while (encodedReceiver.Packets.TryRead(out var unit)) { transport.Write(unit.Data); units++; }
        check(units == 6 && transport.Length == raw.Length, "HEVC generator output is split into six intact access units through the console receiver");
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".hevc");
        await File.WriteAllBytesAsync(path, transport.ToArray());
        try
        {
            var info = new ProcessStartInfo("ffprobe") { RedirectStandardOutput = true, UseShellExecute = false };
            foreach (var arg in new[] { "-v", "error", "-count_frames", "-show_entries", "stream=codec_name,width,height,nb_read_frames", "-of", "json", path }) info.ArgumentList.Add(arg);
            using var probe = Process.Start(info)!;
            using var metadata = JsonDocument.Parse(await probe.StandardOutput.ReadToEndAsync());
            await probe.WaitForExitAsync();
            var video = metadata.RootElement.GetProperty("streams")[0];
            check(probe.ExitCode == 0 && video.GetProperty("codec_name").GetString() == "hevc" && video.GetProperty("width").GetInt32() == 1280 && video.GetProperty("height").GetInt32() == 720 && video.GetProperty("nb_read_frames").GetString() == "6", "forwarded HEVC access units decode as six real 720p frames");
        }
        finally { File.Delete(path); }
    }
}
