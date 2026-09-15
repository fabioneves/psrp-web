using System.Diagnostics;
using System.Text.Json;
using RemotePlay.Services.Software;

public static class TranscoderBenchmark
{
    public static async Task RunAsync()
    {
        using var encoder = SoftwareTranscoder.Start(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=60", "-t", "4",
            "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-threads", "2", "-g", "60", "-x264-params", "aud=1", "-f", "h264", "pipe:1"]);
        using var raw = new MemoryStream();
        await encoder.StandardOutput.BaseStream.CopyToAsync(raw);
        await encoder.WaitForExitAsync();
        var bytes = raw.ToArray();
        var boundaries = new List<int>();
        for (var i = 0; i + 4 < bytes.Length; i++)
            if (bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 0 && bytes[i + 3] == 1 && (bytes[i + 4] & 31) == 9) boundaries.Add(i);
        boundaries.Add(bytes.Length);
        var results = new List<object>();
        foreach (var decode in new[] { 1, 2, 4 })
        foreach (var encode in new[] { 1, 2, 4, 8 })
        {
            Environment.SetEnvironmentVariable("DECODER_THREADS", decode.ToString());
            Environment.SetEnvironmentVariable("ENCODER_THREADS", encode.ToString());
            var throughput = await Measure(bytes, boundaries, false);
            var live = await Measure(bytes, boundaries, true);
            results.Add(new { decoderThreads = decode, encoderThreads = encode, throughputFps = throughput.frames * 1000 / throughput.elapsed,
                firstVideoMs = live.firstVideo, elapsedMs = throughput.elapsed, outputFrames = throughput.frames });
        }
        Console.WriteLine(JsonSerializer.Serialize(new { measuredAt = DateTimeOffset.UtcNow, profile = "1080p60", results }, new JsonSerializerOptions { WriteIndented = true }));
    }

    private static async Task<(double elapsed, double firstVideo, int frames)> Measure(byte[] bytes, List<int> frames, bool paced)
    {
        using var process = SoftwareTranscoder.Start(SoftwareTranscoder.BuildArguments(20000, "1080p", 60));
        var clock = Stopwatch.StartNew();
        double first = 0;
        var pictures = 0;
        var errors = process.StandardError.ReadToEndAsync();
        var drain = Task.Run(async () =>
        {
            var buffer = new byte[16384];
            uint prefix = uint.MaxValue;
            int count;
            while ((count = await process.StandardOutput.BaseStream.ReadAsync(buffer)) > 0)
                for (var i = 0; i < count; i++)
                {
                    prefix = (prefix << 8) | buffer[i];
                    if (prefix == 0x00000100) { pictures++; if (first == 0) first = clock.Elapsed.TotalMilliseconds; }
                }
        });
        if (paced)
        {
            for (var i = 0; i < frames.Count - 1; i++)
            {
                var wait = i * 1000.0 / 60 - clock.Elapsed.TotalMilliseconds;
                if (wait > 0) await Task.Delay(TimeSpan.FromMilliseconds(wait));
                await process.StandardInput.BaseStream.WriteAsync(bytes.AsMemory(frames[i], frames[i + 1] - frames[i]));
            }
        }
        else await process.StandardInput.BaseStream.WriteAsync(bytes);
        process.StandardInput.Close();
        await drain; await process.WaitForExitAsync();
        if (process.ExitCode != 0) throw new Exception(await errors);
        return (clock.Elapsed.TotalMilliseconds, first, pictures);
    }
}
