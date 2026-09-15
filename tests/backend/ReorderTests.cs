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
        received.Clear();
        queue = new ReorderQueue<Packet>(NullLogger.Instance, packet => packet.Sequence, packet => received.Add(packet.Sequence));
        queue.Push(new(65534)); queue.Push(new(0)); queue.Push(new(65535)); queue.Push(new(1));
        check(received.SequenceEqual(new uint[] { 65534, 65535, 0, 1 }), "packet gap recovery preserves sequence wraparound");
    }
}
