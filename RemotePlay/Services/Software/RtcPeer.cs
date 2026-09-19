using System.Runtime.InteropServices;
using System.Text;
using static RemotePlay.Services.Software.LibDataChannel;

namespace RemotePlay.Services.Software;

/// <summary>One libdatachannel peer connection with a single data channel, created here or by the remote side.</summary>
public sealed class RtcPeer : IDisposable
{
    public static bool Available { get; } = NativeLibrary.TryLoad("datachannel", typeof(RtcPeer).Assembly, null, out _);

    // Native threads call these for the life of the process, so the delegates must never be collected.
    private static readonly StateCallback Gathering = (_, state, user) => { if (state == GatheringComplete) From(user)?.gathered.TrySetResult(); };
    private static readonly StateCallback State = (_, state, user) => { if (state is StateFailed or StateClosed) From(user)?.closed.TrySetResult(); };
    private static readonly ChannelCallback RemoteChannel = (_, dc, user) => From(user)?.Adopt(dc);
    private static readonly IdCallback ChannelOpen = (_, user) => From(user)?.opened.TrySetResult();
    private static readonly IdCallback ChannelClosed = (_, user) => From(user)?.closed.TrySetResult();
    private static readonly MessageCallback ChannelMessage = (_, message, size, user) =>
    {
        var handler = From(user)?.Message;
        if (size < 0 || handler is null) return;
        var copy = new byte[size];
        Marshal.Copy(message, copy, 0, size);
        try { handler(copy); } catch (Exception) { }
    };

    private readonly TaskCompletionSource gathered = new(TaskCreationOptions.RunContinuationsAsynchronously),
        opened = new(TaskCreationOptions.RunContinuationsAsynchronously), closed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly object sync = new();
    private GCHandle self;
    private readonly int pc;
    private int channel = -1;
    private bool disposed;

    public event Action<byte[]>? Message;
    public Task Opened => opened.Task;
    /// <summary>Completes when the connection failed or closed, or the channel closed; never faults.</summary>
    public Task Closed => closed.Task;

    /// <param name="port">A fixed UDP port shared by every peer of this process, or 0 for any.</param>
    public RtcPeer(ushort port = 0)
    {
        if (!Available) throw new InvalidOperationException("libdatachannel is not installed.");
        var configuration = new Configuration { PortRangeBegin = port, PortRangeEnd = port, EnableIceUdpMux = (byte)(port == 0 ? 0 : 1) };
        pc = rtcCreatePeerConnection(configuration);
        if (pc < 0) throw new IOException($"WebRTC peer connection could not be created ({pc}).");
        self = GCHandle.Alloc(this);
        rtcSetUserPointer(pc, GCHandle.ToIntPtr(self));
        rtcSetGatheringStateChangeCallback(pc, Gathering);
        rtcSetStateChangeCallback(pc, State);
        rtcSetDataChannelCallback(pc, RemoteChannel);
    }

    private static RtcPeer? From(IntPtr user) => user == IntPtr.Zero ? null : GCHandle.FromIntPtr(user).Target as RtcPeer;

    private void Adopt(int dc)
    {
        lock (sync)
        {
            if (disposed || channel >= 0) { rtcDeleteDataChannel(dc); return; }
            channel = dc;
        }
        rtcSetUserPointer(dc, GCHandle.ToIntPtr(self));
        rtcSetOpenCallback(dc, ChannelOpen);
        rtcSetClosedCallback(dc, ChannelClosed);
        rtcSetMessageCallback(dc, ChannelMessage);
        if (rtcIsOpen(dc)) opened.TrySetResult();
    }

    public void CreateChannel(string label, bool unordered, uint? maxRetransmits)
    {
        var init = new DataChannelInit { Reliability = new() { Unordered = (byte)(unordered ? 1 : 0), Unreliable = (byte)(maxRetransmits is null ? 0 : 1), MaxRetransmits = maxRetransmits ?? 0 } };
        var dc = rtcCreateDataChannelEx(pc, label, init);
        if (dc < 0) throw new IOException($"WebRTC data channel could not be created ({dc}).");
        Adopt(dc);
    }

    public void SetRemoteDescription(string sdp, string type)
    {
        if (rtcSetRemoteDescription(pc, sdp, type) < 0) throw new IOException($"The WebRTC {type} was not accepted.");
    }

    /// <summary>The complete local description once every candidate is in it, so nothing has to be trickled.</summary>
    public async Task<string> LocalDescriptionAsync(CancellationToken ct)
    {
        await gathered.Task.WaitAsync(ct);
        var buffer = new byte[16 * 1024];
        var length = rtcGetLocalDescription(pc, buffer, buffer.Length);
        if (length <= 0) throw new IOException($"The WebRTC description could not be read ({length}).");
        return Encoding.UTF8.GetString(buffer, 0, length - 1);
    }

    public bool IsOpen { get { lock (sync) return !disposed && channel >= 0 && !closed.Task.IsCompleted && rtcIsOpen(channel); } }
    public int BufferedAmount { get { lock (sync) return disposed || channel < 0 ? 0 : Math.Max(0, rtcGetBufferedAmount(channel)); } }

    public bool Send(ReadOnlySpan<byte> message)
    {
        lock (sync)
            return !disposed && channel >= 0 && !closed.Task.IsCompleted && message.Length > 0 &&
                rtcSendMessage(channel, ref MemoryMarshal.GetReference(message), message.Length) >= 0;
    }

    public void Dispose()
    {
        lock (sync)
        {
            if (disposed) return;
            disposed = true;
            if (channel >= 0) rtcDeleteDataChannel(channel);
        }
        // Deleting the connection waits for running callbacks and installs none afterwards; only then may the handle go.
        rtcDeletePeerConnection(pc);
        closed.TrySetResult();
        self.Free();
    }
}
