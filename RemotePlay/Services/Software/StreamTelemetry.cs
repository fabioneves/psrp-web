using System.Text.Json;

namespace RemotePlay.Services.Software;

/// <summary>
/// Per-second diagnostics samples a browser streams while its "live telemetry" debug switch is on:
/// the last five minutes of samples and the last 200 events, readable while the stream runs.
/// </summary>
public sealed class StreamTelemetry
{
    public const int SampleLimit = 300, EventLimit = 200;
    private readonly object sync = new();
    private readonly Queue<JsonElement> samples = new(), events = new();
    public int Received { get; private set; }
    public DateTimeOffset? LastAt { get; private set; }

    public void Record(JsonElement sample, JsonElement? newEvents, DateTimeOffset now)
    {
        lock (sync)
        {
            samples.Enqueue(sample.Clone());
            while (samples.Count > SampleLimit) samples.Dequeue();
            if (newEvents is { ValueKind: JsonValueKind.Array } list)
                foreach (var item in list.EnumerateArray()) { events.Enqueue(item.Clone()); while (events.Count > EventLimit) events.Dequeue(); }
            Received++; LastAt = now;
        }
    }

    public (IReadOnlyList<JsonElement> Samples, IReadOnlyList<JsonElement> Events, int Received, DateTimeOffset? LastAt) Snapshot()
    {
        lock (sync) return (samples.ToArray(), events.ToArray(), Received, LastAt);
    }

    /// <summary>One log line's worth of the fields that matter when watching a session live.</summary>
    public static string Summary(JsonElement sample)
    {
        static string Field(JsonElement sample, string name) => sample.TryGetProperty(name, out var value) && value.ValueKind != JsonValueKind.Null ? value.ToString() : "-";
        return string.Join(' ', new[] { "t", "fps", "consoleFps", "display", "displayMax", "displayed", "displayReplaced", "max", "target", "videoUnderruns", "rebuilt", "recovered", "dropped", "queue", "arrivalP95", "arrivalMax", "transportP95", "rtt", "mbps", "stalls", "lost", "idr", "underruns" }
            .Select(name => $"{name}={Field(sample, name)}"));
    }
}
