using RemotePlay.Services.Software;
using System.Diagnostics;
using System.Text.Json;
using System.Buffers.Binary;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using RemotePlay.Services.Auth;
using Concentus;
using Concentus.Enums;

if (args.Contains("--benchmark")) { await TranscoderBenchmark.RunAsync(); return; }

static void Check(bool value, string message)
{
    if (!value) throw new Exception(message);
    Console.WriteLine($"PASS: {message}");
}

if (args.Contains("--psn-storage")) { await PsnStorageTests.RunAsync(Check); return; }

var clock = new TestClock();
await ConsoleSocketTests.RunAsync(Check);
await ReorderTests.RunAsync(Check);
await DiscoveryTests.RunAsync(Check);
await PsnTests.RunAsync(Check);
var browserRequest = new Microsoft.AspNetCore.Http.DefaultHttpContext().Request;
browserRequest.Host = new Microsoft.AspNetCore.Http.HostString("play.example.test");
Check(!BrowserSession.IsSameOrigin(browserRequest), "session restoration requires an explicit browser request header");
browserRequest.Headers["X-Remote-Play-Session"] = "1";
browserRequest.Headers.Origin = "https://play.example.test";
browserRequest.Headers["Sec-Fetch-Site"] = "same-origin";
var cookieOptions = BrowserSession.Options(browserRequest);
Check(BrowserSession.IsSameOrigin(browserRequest) && cookieOptions.HttpOnly && cookieOptions.Secure &&
    cookieOptions.SameSite == Microsoft.AspNetCore.Http.SameSiteMode.Strict && cookieOptions.Path == "/api/auth",
    "HTTPS browser sessions use scoped HttpOnly Secure SameSite cookies behind the proxy");
browserRequest.Headers.Remove("X-Remote-Play-Session");
Check(BrowserSession.CanPersistLogin(browserRequest) && !BrowserSession.IsSameOrigin(browserRequest),
    "older same-origin login pages receive a cookie without relaxing session endpoint protection");
browserRequest.Headers["X-Remote-Play-Session"] = "1";
browserRequest.Headers.Origin = "https://other.example.test";
Check(!BrowserSession.IsSameOrigin(browserRequest), "another origin cannot restore or clear a browser session");
Check(!BrowserSession.CanPersistLogin(browserRequest), "cross-origin logins do not set a saved session cookie");
browserRequest.Headers.Origin = "https://play.example.test";
browserRequest.Headers["Sec-Fetch-Site"] = "same-site";
Check(!BrowserSession.IsSameOrigin(browserRequest), "same-site cross-origin session requests are rejected");
var tickets = new StreamTickets(clock);
var token = tickets.Issue("alice", "ps5", false, 10000);
Check(tickets.Consume(token)?.UserId == "alice", "ticket retains its owner");
Check(tickets.Consume(token) == null, "ticket cannot be replayed");
token = tickets.Issue("alice", null, true, 10000);
clock.Now = clock.Now.AddSeconds(31);
Check(tickets.Consume(token) == null, "expired ticket is rejected");
Check(tickets.Consume("unknown") == null, "unknown ticket is rejected");

var inputs = new SoftwareInputState();
var viewer = Guid.NewGuid();
var phone = Guid.NewGuid();
inputs.Apply(viewer, new("button", "CROSS", true));
inputs.Apply(phone, new("button", "CROSS", true));
var held = inputs.Apply(phone, new("reset"));
Check(held.Buttons.Contains(RemotePlay.Services.Streaming.Controller.FeedbackEvent.ButtonType.CROSS), "detaching a phone preserves the viewer's held button");
Check(inputs.Apply(viewer, new("reset")).Buttons.Count == 0, "last input owner releases its button");
held = inputs.Apply(phone, new("triggers", L2: 0.4f, R2: 2));
Check(held.L2 == 0.4f && held.R2 == 1 && held.Buttons.Count == 2, "analog triggers clamp and set protocol button flags");
inputs.Apply(viewer, new("stick", Stick: "left", X: 0.2f));
inputs.Apply(phone, new("stick", Stick: "left", X: 0.7f));
Check(inputs.Apply(phone, new("reset")).Left.X == 0.2f, "detaching restores another source's analog stick");
var invalidInput = false;
try { inputs.Apply(phone, new("stick", Stick: "left", X: float.NaN)); }
catch (IOException) { invalidInput = true; }
Check(invalidInput, "nonfinite analog input is rejected");

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

using var audioReceiver = new SoftwareReceiver();
var audioHeader = new byte[14];
audioHeader[0] = 2; audioHeader[1] = 16;
BinaryPrimitives.WriteInt32BigEndian(audioHeader.AsSpan(2), 48000);
BinaryPrimitives.WriteInt32BigEndian(audioHeader.AsSpan(6), 960);
audioReceiver.OnStreamInfo([], audioHeader);
using var encoder = OpusCodecFactory.CreateEncoder(48000, 2, OpusApplication.OPUS_APPLICATION_AUDIO);
var sine = new float[1920];
for (var i = 0; i < 960; i++) sine[i * 2] = sine[i * 2 + 1] = (float)(0.2 * Math.Sin(i * 2 * Math.PI * 440 / 48000));
var encodedAudio = new byte[4000];
var encodedSize = encoder.Encode(sine, 960, encodedAudio, encodedAudio.Length);
audioReceiver.OnAudioPacket([1, .. encodedAudio.AsSpan(0, encodedSize)]);
Check(audioReceiver.AudioPackets.TryRead(out var pcm) && pcm.Length == 3884 && pcm.AsSpan(0, 4).SequenceEqual("RPM1"u8) && pcm.AsSpan(32, 4).SequenceEqual("PCM1"u8), "real Opus frames decode to stereo PCM transport");
Check(pcm!.Skip(44).Any(value => value != 0), "decoded Opus contains audible samples");
Check(BinaryPrimitives.ReadInt32LittleEndian(pcm!.AsSpan(4)) == 2 &&
    BinaryPrimitives.ReadDoubleLittleEndian(pcm.AsSpan(8)) - BinaryPrimitives.ReadDoubleLittleEndian(pcm.AsSpan(24)) == 20,
    "audio transport timestamps the first sample and packet readiness separately");
var fullHd = SoftwareTranscoder.BuildArguments(20000, "1080p", 60);
Check(fullHd.Contains("scale=1920:1080:flags=fast_bilinear"), "1080p60 config reaches the CPU encoder");
Check(VideoProfile.Create("540p", 30).Width == 960, "540p30 console profile resolves correctly");
var invalidProfile = false;
try { VideoProfile.Create("4k", 60); } catch (ArgumentException) { invalidProfile = true; }
Check(invalidProfile, "unsupported resolution is rejected");

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
