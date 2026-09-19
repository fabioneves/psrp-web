using System.Runtime.InteropServices;

namespace RemotePlay.Services.Software;

/// <summary>The part of libdatachannel's C API (rtc/rtc.h, v0.24.5) that a data-channel sender needs. Layouts follow the header field for field.</summary>
internal static class LibDataChannel
{
    private const string Library = "datachannel";
    public const int GatheringComplete = 2, StateFailed = 4, StateClosed = 5, LogWarning = 3;

    [StructLayout(LayoutKind.Sequential)]
    public struct Configuration
    {
        public IntPtr IceServers; public int IceServersCount; public IntPtr ProxyServer, BindAddress;
        public int CertificateType, IceTransportPolicy;
        public byte EnableIceTcp, EnableIceUdpMux, DisableAutoNegotiation, ForceMediaTransport;
        public ushort PortRangeBegin, PortRangeEnd;
        public int Mtu, MaxMessageSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Reliability { public byte Unordered, Unreliable; public uint MaxPacketLifeTime, MaxRetransmits; }

    [StructLayout(LayoutKind.Sequential)]
    public struct DataChannelInit { public Reliability Reliability; public IntPtr Protocol; public byte Negotiated, ManualStream; public ushort Stream; }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void StateCallback(int id, int state, IntPtr user);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void ChannelCallback(int pc, int dc, IntPtr user);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void IdCallback(int id, IntPtr user);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void MessageCallback(int id, IntPtr message, int size, IntPtr user);

    [DllImport(Library)] public static extern void rtcInitLogger(int level, IntPtr callback);
    [DllImport(Library)] public static extern void rtcSetUserPointer(int id, IntPtr user);
    [DllImport(Library)] public static extern int rtcCreatePeerConnection(in Configuration configuration);
    [DllImport(Library)] public static extern int rtcDeletePeerConnection(int pc);
    [DllImport(Library)] public static extern int rtcSetStateChangeCallback(int pc, StateCallback callback);
    [DllImport(Library)] public static extern int rtcSetGatheringStateChangeCallback(int pc, StateCallback callback);
    [DllImport(Library)] public static extern int rtcSetDataChannelCallback(int pc, ChannelCallback callback);
    [DllImport(Library)] public static extern int rtcSetRemoteDescription(int pc, [MarshalAs(UnmanagedType.LPUTF8Str)] string sdp, [MarshalAs(UnmanagedType.LPUTF8Str)] string type);
    [DllImport(Library)] public static extern int rtcGetLocalDescription(int pc, byte[] buffer, int size);
    [DllImport(Library)] public static extern int rtcCreateDataChannelEx(int pc, [MarshalAs(UnmanagedType.LPUTF8Str)] string label, in DataChannelInit init);
    [DllImport(Library)] public static extern int rtcDeleteDataChannel(int dc);
    [DllImport(Library)] public static extern int rtcSetOpenCallback(int id, IdCallback callback);
    [DllImport(Library)] public static extern int rtcSetClosedCallback(int id, IdCallback callback);
    [DllImport(Library)] public static extern int rtcSetMessageCallback(int id, MessageCallback callback);
    [DllImport(Library)] [return: MarshalAs(UnmanagedType.U1)] public static extern bool rtcIsOpen(int id);
    [DllImport(Library)] public static extern int rtcSendMessage(int id, ref byte data, int size);
    [DllImport(Library)] public static extern int rtcGetBufferedAmount(int id);
}
