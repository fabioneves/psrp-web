using System.Buffers.Binary;
using RemotePlay.Services.Software;

static class RtcTests
{
    public static void Run(Action<bool, string> check)
    {
        foreach (var length in new[] { 1, FrameFragmenter.MaxPayload, FrameFragmenter.MaxPayload + 1, 2 * 1024 * 1024 })
        {
            var packet = new byte[length];
            new Random(length).NextBytes(packet);
            var fragments = FrameFragmenter.Split(7, packet).ToList();
            var expected = (length + FrameFragmenter.MaxPayload - 1) / FrameFragmenter.MaxPayload;
            var headers = fragments.Select((fragment, index) =>
                BinaryPrimitives.ReadUInt32LittleEndian(fragment) == 7 &&
                BinaryPrimitives.ReadUInt16LittleEndian(fragment.AsSpan(4)) == index &&
                BinaryPrimitives.ReadUInt16LittleEndian(fragment.AsSpan(6)) == expected);
            var rebuilt = fragments.SelectMany(fragment => fragment.Skip(FrameFragmenter.HeaderSize)).ToArray();
            check(fragments.Count == expected && headers.All(ok => ok) &&
                fragments.All(fragment => fragment.Length <= FrameFragmenter.HeaderSize + FrameFragmenter.MaxPayload) &&
                rebuilt.AsSpan().SequenceEqual(packet),
                $"a {length}-byte access unit survives fragmenting into {expected} data-channel messages");
        }
        var rejected = 0;
        foreach (var packet in new[] { Array.Empty<byte>(), new byte[FrameFragmenter.MaxPayload * (ushort.MaxValue + 1)] })
            try { _ = FrameFragmenter.Split(1, packet).ToList(); } catch (ArgumentException) { rejected++; }
        check(rejected == 2, "an empty access unit and one needing more fragments than the header can count are rejected");
    }
}
