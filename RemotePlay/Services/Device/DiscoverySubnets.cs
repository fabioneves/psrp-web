using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;

namespace RemotePlay.Services.Device;

public static class DiscoverySubnets
{
    public static IReadOnlySet<IPAddress> Parse(string? configuration)
    {
        var hosts = new HashSet<IPAddress>();
        var subnets = (configuration ?? "").Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (subnets.Length > 4) throw new ArgumentException("DISCOVERY_SUBNETS accepts at most four IPv4 subnets.");
        foreach (var subnet in subnets)
        {
            var parts = subnet.Split('/');
            if (parts.Length != 2 || !IPAddress.TryParse(parts[0], out var address) ||
                address.AddressFamily != AddressFamily.InterNetwork || !int.TryParse(parts[1], out var prefix) ||
                prefix < 24 || prefix > 30)
                throw new ArgumentException("DISCOVERY_SUBNETS requires IPv4 CIDRs from /24 through /30, such as 192.168.1.0/24.");
            var bytes = address.GetAddressBytes();
            var privateAddress = bytes[0] is 10 or 127 || (bytes[0] == 172 && bytes[1] is >= 16 and <= 31) ||
                (bytes[0] == 192 && bytes[1] == 168);
            if (!privateAddress) throw new ArgumentException("DISCOVERY_SUBNETS only accepts private or loopback IPv4 networks.");
            var size = 1u << (32 - prefix);
            var network = BinaryPrimitives.ReadUInt32BigEndian(bytes) & ~(size - 1);
            for (uint offset = 1; offset < size - 1; offset++)
            {
                BinaryPrimitives.WriteUInt32BigEndian(bytes, network + offset);
                hosts.Add(new IPAddress(bytes));
            }
        }
        return hosts;
    }
}
