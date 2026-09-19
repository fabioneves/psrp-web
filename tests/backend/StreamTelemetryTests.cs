using System.Text.Json;
using RemotePlay.Services.Software;

static class StreamTelemetryTests
{
    public static void Run(Action<bool, string> check)
    {
        var telemetry = new StreamTelemetry();
        var now = DateTimeOffset.UtcNow;
        for (var i = 0; i < StreamTelemetry.SampleLimit + 25; i++)
            telemetry.Record(JsonDocument.Parse($"{{\"t\":{i},\"fps\":60}}").RootElement, i % 2 == 0 ? JsonDocument.Parse("[{\"type\":\"stall\"}]").RootElement : null, now.AddSeconds(i));
        var (samples, events, received, lastAt) = telemetry.Snapshot();
        check(samples.Count == StreamTelemetry.SampleLimit && samples[0].GetProperty("t").GetInt32() == 25 && samples[^1].GetProperty("t").GetInt32() == StreamTelemetry.SampleLimit + 24,
            "telemetry keeps the newest five minutes of samples in order");
        check(events.Count == 163 && received == StreamTelemetry.SampleLimit + 25 && lastAt == now.AddSeconds(StreamTelemetry.SampleLimit + 24), "events accumulate up to their limit and counters track every message");
        var summary = StreamTelemetry.Summary(JsonDocument.Parse("{\"t\":5000,\"fps\":59.9,\"consoleFps\":60,\"rtt\":4.2}").RootElement);
        check(summary.StartsWith("t=5000 fps=59.9 consoleFps=60 display=- displayMax=- ") && summary.Contains("rtt=4.2") && summary.Contains(" rebuilt=- "), "the log summary names each field and marks missing ones");
        var channel = StreamTelemetry.Summary(JsonDocument.Parse("{\"transport\":\"webrtc\",\"abandoned\":2,\"rtcKeyframes\":1,\"senderSkipped\":5,\"pairRtt\":44}").RootElement);
        check(channel.Contains(" transport=webrtc abandoned=2 rtcKeyframes=1 senderSkipped=5 pairRtt=44 "), "the log summary shows the video transport and what it lost, so a session can be followed over SSH");
    }
}
