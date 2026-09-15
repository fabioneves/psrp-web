using System.Diagnostics;
using Microsoft.Extensions.Logging.Abstractions;
using RemotePlay.Services.Streaming.Buffer;

static class ReorderTests
{
    private sealed record Packet(uint Sequence);
    public static async Task RunAsync(Action<bool, string> check)
    {
        var received = new List<uint>();
        var queue = new ReorderQueue<Packet>(NullLogger.Instance, packet => packet.Sequence, packet => received.Add(packet.Sequence), maxBufferFrames: 256, timeoutMsBase: 300);
        queue.Push(new(0)); queue.Push(new(2)); queue.Push(new(3)); queue.Push(new(1));
        check(received.SequenceEqual(new uint[] { 0, 1, 2, 3 }), "filling a packet gap immediately releases all consecutive packets");
        queue.Push(new(6));
        var watch = Stopwatch.StartNew();
        while (received.Count < 5 && watch.ElapsedMilliseconds < 100) { await Task.Delay(2); queue.Flush(); }
        check(received.Last() == 6 && watch.ElapsedMilliseconds < 100, "lost packets cannot hold newer video for 300 milliseconds");
        queue.Push(new(5)); queue.Push(new(7));
        check(received.SequenceEqual(new uint[] { 0, 1, 2, 3, 6, 7 }), "late packets cannot rewind the video sequence");
        foreach (var window in new[] { 8, 192 })
        foreach (var (start, jump) in new[] { (9000u, 32u), (9000u, 500u), (9000u, 4000u), (65530u, 4000u) })
        {
            var recovered = new List<uint>();
            var recovery = new ReorderQueue<Packet>(NullLogger.Instance, packet => packet.Sequence, packet => recovered.Add(packet.Sequence), maxBufferFrames: window);
            recovery.Push(new(start)); recovery.Push(new((start + 2) & 65535));
            var next = (start + jump) & 65535;
            recovery.Push(new(next)); recovery.Push(new((next + 1) & 65535));
            await Task.Delay(25); recovery.Flush();
            check(recovered.TakeLast(2).SequenceEqual(new[] { next, (next + 1) & 65535 }),
                $"video resumes after a {jump}-packet forward gap at sequence {start} with a {window}-packet window");
            recovery.Push(new((next - 1) & 65535)); recovery.Push(new((next + 2) & 65535));
            check(recovered.Last() == ((next + 2) & 65535) && recovery.GetStats().bufferSize <= window,
                "resynchronized video stays bounded and rejects late packets");
        }
        received.Clear();
        queue = new ReorderQueue<Packet>(NullLogger.Instance, packet => packet.Sequence, packet => received.Add(packet.Sequence));
        queue.Push(new(65534)); queue.Push(new(0)); queue.Push(new(65535)); queue.Push(new(1));
        check(received.SequenceEqual(new uint[] { 65534, 65535, 0, 1 }), "packet gap recovery preserves sequence wraparound");
    }
}
