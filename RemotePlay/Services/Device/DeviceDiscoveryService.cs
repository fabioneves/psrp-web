using RemotePlay.Contracts.Enums;
using RemotePlay.Contracts.Services;
using RemotePlay.Models.PlayStation;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace RemotePlay.Services.Device
{

    public class DeviceDiscoveryService : IDeviceDiscoveryService
    {
        private readonly ILogger<DeviceDiscoveryService> _logger;
        private const string BROADCAST_IP = "255.255.255.255";
        private const int DISCOVERY_PORT = 9302;
        private const int CLIENT_PORT = 9303;
        private const string DISCOVERY_PROTOCOL_VERSION = "00030010";
        private const int PS4_DDP_PORT = 987;
        private const int PS5_DDP_PORT = 9302;
        private readonly SemaphoreSlim _discoverySemaphore = new(1, 1);
        private readonly IReadOnlySet<IPAddress> _subnetHosts;

        public DeviceDiscoveryService(ILogger<DeviceDiscoveryService> logger, IConfiguration configuration)
        {
            _logger = logger;
            _subnetHosts = DiscoverySubnets.Parse(configuration["DISCOVERY_SUBNETS"]);
        }

        public async Task<List<ConsoleInfo>> DiscoverDevicesAsync(int timeoutMs = 2000, CancellationToken cancellationToken = default)
        {
            if (_subnetHosts.Count > 0)
                return await DiscoverSubnetsAsync(timeoutMs, cancellationToken);
            var discoveredDevices = new List<ConsoleInfo>();
            var discoveryTasks = new List<Task<List<ConsoleInfo>>>();

            try
            {
                var networkInterfaces = GetActiveNetworkInterfaces();

                foreach (var networkInterface in networkInterfaces)
                {
                    var unicastAddresses = GetUnicastAddresses(networkInterface);
                    foreach (var address in unicastAddresses)
                    {
                        var broadcast = CalculateBroadcastAddress(address.Address, address.IPv4Mask);
                        if (broadcast is null)
                        {
                            continue;
                        }

                        var task = DiscoverOnNetworkAsync(address.Address, broadcast, timeoutMs, cancellationToken);
                        discoveryTasks.Add(task);
                    }
                }

                var results = await Task.WhenAll(discoveryTasks);
                discoveredDevices = results.SelectMany(x => x).ToList();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "设备发现过程中发生错误");
                throw;
            }

            return discoveredDevices;
        }

        private async Task<List<ConsoleInfo>> DiscoverSubnetsAsync(int timeoutMs, CancellationToken cancellationToken)
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(Math.Clamp(timeoutMs, 100, 10000));
            using var client = new UdpClient(new IPEndPoint(IPAddress.Any, 0));
            var devices = new Dictionary<string, ConsoleInfo>();
            var requests = new[]
            {
                (Port: PS5_DDP_PORT, Bytes: CreateDiscoveryRequest()),
                (Port: PS4_DDP_PORT, Bytes: Encoding.ASCII.GetBytes("SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00020020\n"))
            };

            async Task SendAsync()
            {
                try
                {
                    foreach (var host in _subnetHosts)
                    {
                        foreach (var request in requests)
                        {
                            try { await client.SendAsync(request.Bytes, new IPEndPoint(host, request.Port), deadline.Token); }
                            catch (SocketException ex) { _logger.LogDebug(ex, "Discovery probe failed for {Host}:{Port}", host, request.Port); }
                        }
                        await Task.Delay(1, deadline.Token);
                    }
                }
                catch (OperationCanceledException) when (deadline.IsCancellationRequested) { }
            }

            async Task ReceiveAsync()
            {
                try
                {
                    while (!deadline.IsCancellationRequested)
                    {
                        UdpReceiveResult response;
                        try { response = await client.ReceiveAsync(deadline.Token); }
                        catch (SocketException ex)
                        {
                            _logger.LogDebug(ex, "Discovery reply socket error");
                            continue;
                        }
                        if (!_subnetHosts.Contains(response.RemoteEndPoint.Address) ||
                            response.RemoteEndPoint.Port is not PS4_DDP_PORT and not PS5_DDP_PORT) continue;
                        var device = ParseDeviceResponse(response.Buffer, response.RemoteEndPoint);
                        if (device != null) devices[device.Uuid] = device;
                    }
                }
                catch (OperationCanceledException) when (deadline.IsCancellationRequested) { }
            }

            await Task.WhenAll(ReceiveAsync(), SendAsync());
            cancellationToken.ThrowIfCancellationRequested();
            _logger.LogInformation("Subnet discovery checked {Hosts} addresses and found {Count} consoles", _subnetHosts.Count, devices.Count);
            return devices.Values.ToList();
        }

        public async Task<ConsoleInfo?> DiscoverDeviceAsync(
            string hostIp,
            int timeoutMs = 2000,
            CancellationToken cancellationToken = default)
        {
            if (!IPAddress.TryParse(hostIp, out var address)) throw new ArgumentException("Invalid console IP address.", nameof(hostIp));
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(Math.Clamp(timeoutMs, 100, 10000));
            using var client = new UdpClient(address.AddressFamily);
            await client.SendAsync(CreateDiscoveryRequest(), new IPEndPoint(address, PS5_DDP_PORT), cancellationToken);
            await client.SendAsync(Encoding.ASCII.GetBytes("SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00020020\n"), new IPEndPoint(address, PS4_DDP_PORT), cancellationToken);
            try
            {
                while (true)
                {
                    UdpReceiveResult response;
                    try { response = await client.ReceiveAsync(deadline.Token); }
                    catch (SocketException) { continue; }
                    if (!response.RemoteEndPoint.Address.Equals(address) || response.RemoteEndPoint.Port is not PS4_DDP_PORT and not PS5_DDP_PORT) continue;
                    var found = ParseDeviceResponse(response.Buffer, response.RemoteEndPoint);
                    if (found != null) return found;
                }
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { return null; }
        }

        public async Task<bool> WakeUpDeviceAsync(
            string host,
            string credential,
            string hostType,
            CancellationToken cancellationToken = default)
        {
            if (!IPAddress.TryParse(host, out var address)) throw new ArgumentException("Invalid console IP address.", nameof(host));
            var targetPort = hostType == "PS5" ? PS5_DDP_PORT : PS4_DDP_PORT;
            var message = CreateWakeUpRequest(FormatRegistKey(credential));
            if (hostType != "PS5") message = Encoding.ASCII.GetBytes(Encoding.ASCII.GetString(message).Replace("00030010", "00020020"));
            using var client = new UdpClient(address.AddressFamily);
            await client.SendAsync(message, new IPEndPoint(address, targetPort), cancellationToken);
            return true;
        }

        private async Task<List<ConsoleInfo>> DiscoverOnNetworkAsync(IPAddress localAddress, IPAddress broadcastAddress, int timeoutMs, CancellationToken cancellationToken)
        {
            var discoveredDevices = new List<ConsoleInfo>();

            var lockTaken = false;

            try
            {
                await _discoverySemaphore.WaitAsync(cancellationToken);
                lockTaken = true;

                var request = CreateDiscoveryRequest();
                var broadcastEndPoint = new IPEndPoint(broadcastAddress, DISCOVERY_PORT);
                var localEndPoint = new IPEndPoint(localAddress, CLIENT_PORT);

                using var client = new UdpClient(localEndPoint);
                client.EnableBroadcast = true;

                await client.SendAsync(request, request.Length, broadcastEndPoint);

                var endTime = DateTime.UtcNow.AddMilliseconds(timeoutMs);
                while (DateTime.UtcNow < endTime && !cancellationToken.IsCancellationRequested)
                {
                    try
                    {
                        var receiveTask = client.ReceiveAsync();
                        var delayTask = Task.Delay(Math.Max(0, (int)(endTime - DateTime.UtcNow).TotalMilliseconds), cancellationToken);
                        var completed = await Task.WhenAny(receiveTask, delayTask);

                        if (completed == receiveTask)
                        {
                            var result = receiveTask.Result;
                            var deviceInfo = ParseDeviceResponse(result.Buffer, result.RemoteEndPoint);
                            if (deviceInfo != null && !discoveredDevices.Any(d => d.Uuid == deviceInfo.Uuid))
                            {
                                discoveredDevices.Add(deviceInfo);
                            }
                        }
                        else
                        {
                            break;
                        }
                    }
                    catch (SocketException)
                    {
                        break;
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "在网络接口 {LocalAddress} 上发现设备时发生错误", localAddress);
            }
            finally
            {
                if (lockTaken)
                {
                    _discoverySemaphore.Release();
                }
            }

            return discoveredDevices;
        }

        private List<NetworkInterface> GetActiveNetworkInterfaces()
        {
            return NetworkInterface.GetAllNetworkInterfaces()
                .Where(ni => ni.OperationalStatus == OperationalStatus.Up &&
                           ni.NetworkInterfaceType != NetworkInterfaceType.Loopback &&
                           ni.NetworkInterfaceType != NetworkInterfaceType.Tunnel &&
                           !IsVirtualInterface(ni))
                .ToList();
        }

        private bool IsVirtualInterface(NetworkInterface networkInterface)
        {
            var description = networkInterface.Description.ToLowerInvariant();
            var name = networkInterface.Name.ToLowerInvariant();
            var virtualKeywords = new[]
            {
                "virtual",
                "vmware",
                "loopback",
                "hyper-v",
                "npcap",
                "docker",
                "container",
                "wan miniport",
                "isatap",
                "teredo"
            };

            return virtualKeywords.Any(keyword => description.Contains(keyword) || name.Contains(keyword));
        }

        private List<UnicastIPAddressInformation> GetUnicastAddresses(NetworkInterface networkInterface)
        {
            var addresses = new List<UnicastIPAddressInformation>();
            var ipProperties = networkInterface.GetIPProperties();

            foreach (var address in ipProperties.UnicastAddresses)
            {
                if (address.Address.AddressFamily != AddressFamily.InterNetwork)
                {
                    continue;
                }
                var mask = address.IPv4Mask;
                if (mask is null)
                {
                    continue;
                }

                var maskBytes = mask.GetAddressBytes();
                if (maskBytes.All(b => b == 0))
                {
                    continue;
                }

                addresses.Add(address);
            }

            return addresses;
        }

        private byte[] GetDDPMessage(DDPMsgType ddpType, Dictionary<string, string>? data = null)
        {
            var request = $"{ddpType} * HTTP/1.1\n";
            if (data != null)
                foreach (var k in data)
                    request = request + $"{k.Key}:{k.Value}\n";
            request = request + $"device-discovery-protocol-version:{DISCOVERY_PROTOCOL_VERSION}\n";
            return Encoding.UTF8.GetBytes(request);
        }

        private byte[] CreateDiscoveryRequest() => GetDDPMessage(DDPMsgType.SRCH);

        private byte[] CreateWakeUpRequest(string credential)
        {
            var data = new Dictionary<string, string>
            {
                { "user-credential", credential},
                { "client-type", "vr" },
                { "auth-type","R" },
                { "model", "w" },
                { "app-type", "r" },
            };
            return GetDDPMessage(DDPMsgType.WAKEUP, data);
        }

        private IPAddress? CalculateBroadcastAddress(IPAddress localAddress, IPAddress? subnetMask)
        {
            if (subnetMask is null)
            {
                return null;
            }

            var addressBytes = localAddress.GetAddressBytes();
            var maskBytes = subnetMask.GetAddressBytes();

            if (addressBytes.Length != maskBytes.Length)
            {
                return null;
            }

            if (maskBytes.All(b => b == 0))
            {
                return null;
            }

            var broadcastBytes = new byte[addressBytes.Length];
            for (var i = 0; i < addressBytes.Length; i++)
            {
                broadcastBytes[i] = (byte)(addressBytes[i] | (maskBytes[i] ^ 0xFF));
            }

            return new IPAddress(broadcastBytes);
        }

        private ConsoleInfo? ParseDeviceResponse(byte[] buffer, IPEndPoint remoteEndPoint)
        {
            if (buffer is null or { Length: 0 }) return null;

            try
            {
                var response = Encoding.ASCII.GetString(buffer);
                var lines = response.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

                string name = "Unknown";
                string? hostId = null;
                string? hostType = null;
                string? systemVersion = null;
                string? status = null;
                string? deviceDiscoveryProtocolVersion = null;
                var reStatus = new Regex(@"HTTP/1\.1\s+(?<code>\d+)\s+(?<status>.+)", RegexOptions.Compiled);
                foreach (var line in lines)
                {
                    var match = reStatus.Match(line);
                    if (match.Success)
                    {
                        status = match.Groups["status"].Value;
                        continue;
                    }
                    var parts = line.Split(':', 2, StringSplitOptions.TrimEntries);
                    if (parts.Length != 2) continue;
                    switch (parts[0].ToLowerInvariant())
                    {
                        case "host-name": name = parts[1]; break;
                        case "host-id": hostId = parts[1]; break;
                        case "host-type": hostType = parts[1]; break;
                        case "system-version": systemVersion = parts[1]; break;
                        case "device-discovery-protocol-version": deviceDiscoveryProtocolVersion = parts[1]; break;
                    }


                }

                return string.IsNullOrEmpty(hostId)
                    ? null
                    : new ConsoleInfo(
                        remoteEndPoint.Address.ToString(),
                        name,
                        hostId!,
                        hostType,
                        systemVersion,
                        deviceDiscoveryProtocolVersion,
                        status);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "解析设备响应时发生错误");
                return null;
            }
        }

        public static string FormatRegistKey(string registKey)
        {
            var value = Encoding.ASCII.GetString(Convert.FromHexString(registKey)).TrimEnd('\0');
            if (value.Length is < 1 or > 16 || !ulong.TryParse(value, System.Globalization.NumberStyles.AllowHexSpecifier,
                    System.Globalization.CultureInfo.InvariantCulture, out var credential))
                throw new ArgumentException("Invalid console registration key.", nameof(registKey));
            return credential.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

    }
}
