using RemotePlay.Services.Software;
using System.Diagnostics;
using System.Text.Json;
using System.Buffers.Binary;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using RemotePlay.Services.Auth;

static void Check(bool value, string message)
{
    if (!value) throw new Exception(message);
    Console.WriteLine($"PASS: {message}");
}

var clock = new TestClock();
var tickets = new StreamTickets(clock);
var token = tickets.Issue("alice", "ps5", false, 10000);
Check(tickets.Consume(token)?.UserId == "alice", "ticket retains its owner");
Check(tickets.Consume(token) == null, "ticket cannot be replayed");
token = tickets.Issue("alice", null, true, 10000);
clock.Now = clock.Now.AddSeconds(31);
Check(tickets.Consume(token) == null, "expired ticket is rejected");
Check(tickets.Consume("unknown") == null, "unknown ticket is rejected");

using var receiver = new SoftwareReceiver();
receiver.OnStreamInfo([0, 0, 1, 0x67, 5], []);
receiver.OnVideoPacket([2, 0, 0, 1, 0x41, 9]);
Check(!receiver.Packets.TryRead(out _), "delta frames are withheld until an IDR");
receiver.OnVideoPacket([2, 0, 0, 0, 1, 0x65, 7]);
Check(receiver.Packets.TryRead(out var header) && header[3] == 0x67, "codec header precedes first IDR");
Check(receiver.Packets.TryRead(out var frame) && frame.SequenceEqual(new byte[] { 0, 0, 0, 1, 0x65, 7 }), "upstream packet type is stripped before feeding Annex B to FFmpeg");
receiver.EnterWaitForIdr();
receiver.OnVideoPacket([2, 0, 0, 1, 0x41, 9]);
Check(!receiver.Packets.TryRead(out _), "reference loss waits for a fresh IDR");
Check(!SoftwareReceiver.ContainsIdr([0, 0, 1]), "truncated Annex B is safe");

using var slow = new SoftwareReceiver();
for (var i = 0; i < 12; i++) slow.OnVideoPacket([2, 0, 0, 1, 0x65, 7]);
var faulted = false;
try { await foreach (var packet in slow.Packets.ReadAllAsync()) { } }
catch (IOException) { faulted = true; }
Check(faulted, "overload terminates instead of silently corrupting reference frames");

var argsList = SoftwareTranscoder.BuildArguments(10000);
Check(argsList.Contains("none") && argsList.Contains("mpeg1video") && argsList.Contains("-an"), "transcoder is CPU-only MPEG-1 without audio");
using var ffmpeg = SoftwareTranscoder.Start(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=60", "-t", "1", "-c:v", "mpeg1video", "-bf", "0", "-f", "mpegts", "pipe:1"]);
using var output = new MemoryStream();
await ffmpeg.StandardOutput.BaseStream.CopyToAsync(output);
await ffmpeg.WaitForExitAsync();
Check(ffmpeg.ExitCode == 0 && output.Length > 188 && output.ToArray()[0] == 0x47, "FFmpeg emits a real 720p60 MPEG-TS stream");

using var h264 = SoftwareTranscoder.Start(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=60", "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-g", "15", "-x264-params", "aud=1", "-f", "h264", "pipe:1"]);
using var h264Bytes = new MemoryStream();
await h264.StandardOutput.BaseStream.CopyToAsync(h264Bytes);
await h264.WaitForExitAsync();
Check(h264.ExitCode == 0, "test H.264 encoder completed");
using var consoleReceiver = new SoftwareReceiver();
using var conversion = SoftwareTranscoder.Start(SoftwareTranscoder.BuildArguments(10000));
using var converted = new MemoryStream();
var drain = conversion.StandardOutput.BaseStream.CopyToAsync(converted);
var diagnostics = conversion.StandardError.ReadToEndAsync();
var raw = h264Bytes.ToArray();
var boundaries = new List<int>();
for (var i = 0; i + 4 < raw.Length; i++)
    if (raw[i] == 0 && raw[i + 1] == 0 && raw[i + 2] == 0 && raw[i + 3] == 1 && (raw[i + 4] & 31) == 9)
        boundaries.Add(i);
Check(boundaries.Count == 120, "test source contains 120 H.264 access units");
boundaries.Add(raw.Length);
for (var i = 0; i + 1 < boundaries.Count; i++)
{
    consoleReceiver.OnVideoPacket([2, .. raw.AsSpan(boundaries[i], boundaries[i + 1] - boundaries[i])]);
    while (consoleReceiver.Packets.TryRead(out var packet))
        await conversion.StandardInput.BaseStream.WriteAsync(packet);
}
consoleReceiver.Dispose();
await consoleReceiver.Packets.Completion;
conversion.StandardInput.Close();
await drain;
await conversion.WaitForExitAsync();
Check(conversion.ExitCode == 0 && converted.Length > 188, "upstream-wrapped H.264 survives receiver and CPU transcoder: " + await diagnostics);
var samplePath = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".ts");
await File.WriteAllBytesAsync(samplePath, converted.ToArray());
try
{
    var probeInfo = new ProcessStartInfo("ffprobe") { RedirectStandardOutput = true, UseShellExecute = false };
    foreach (var argument in new[] { "-v", "error", "-show_entries", "stream=codec_name,width,height,r_frame_rate", "-of", "json", samplePath }) probeInfo.ArgumentList.Add(argument);
    using var probe = Process.Start(probeInfo)!;
    using var metadata = JsonDocument.Parse(await probe.StandardOutput.ReadToEndAsync());
    await probe.WaitForExitAsync();
    var tracks = metadata.RootElement.GetProperty("streams");
    Check(tracks.GetArrayLength() == 1, "transcoded transport contains exactly one track (no audio)");
    var video = tracks[0];
    Check(video.GetProperty("codec_name").GetString() == "mpeg1video" && video.GetProperty("width").GetInt32() == 1280 && video.GetProperty("height").GetInt32() == 720 && video.GetProperty("r_frame_rate").GetString() == "60/1", "real transport is MPEG-1 at 1280x720, 60 fps");
}
finally { File.Delete(samplePath); }

var auth = new AuthService(null!, new ConfigurationBuilder().Build(), NullLogger<AuthService>.Instance);
var passwordHash = auth.GeneratePassword("a locally generated test password");
Check(BinaryPrimitives.ReadUInt32BigEndian(Convert.FromBase64String(passwordHash).AsSpan(5, 4)) >= 220000, "password hashing meets the configured work factor");
Check(auth.VerifyHashedPassword(passwordHash, "a locally generated test password") && !auth.VerifyHashedPassword(passwordHash, "wrong"), "password verifier accepts only the matching password");

sealed class TestClock : TimeProvider
{
    public DateTimeOffset Now { get; set; } = DateTimeOffset.UtcNow;
    public override DateTimeOffset GetUtcNow() => Now;
}
