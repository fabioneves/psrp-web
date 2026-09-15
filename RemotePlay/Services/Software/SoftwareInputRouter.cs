using System.Diagnostics;
using System.Net.WebSockets;
using System.Text.Json;
using RemotePlay.Contracts.Services;

namespace RemotePlay.Services.Software;

public sealed class SoftwareInputRouter(IControllerService controller, Guid? sessionId)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly SoftwareInputState state = new();
    private SoftwareInputState.State previous = new();
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    public async Task ReceiveAsync(WebSocket socket, CancellationToken ct, bool acknowledge = false, SemaphoreSlim? sendGate = null)
    {
        var source = Guid.NewGuid();
        var buffer = new byte[2048];
        var heartbeat = Stopwatch.StartNew();
        try
        {
            while (!ct.IsCancellationRequested)
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(10));
                var result = await socket.ReceiveAsync(buffer.AsMemory(), timeout.Token);
                if (result.MessageType == WebSocketMessageType.Close) return;
                if (!result.EndOfMessage || result.MessageType != WebSocketMessageType.Text)
                    throw new IOException("Invalid input message.");
                var input = JsonSerializer.Deserialize<SoftwareInput>(buffer.AsSpan(0, result.Count), JsonOptions)
                    ?? throw new IOException("Empty input message.");
                if (input.Type == "ping")
                {
                    heartbeat.Restart();
                    var received = MediaPacket.Now;
                    if (acknowledge)
                    {
                        if (sendGate != null) await sendGate.WaitAsync(timeout.Token);
                        try
                        {
                            var pong = JsonSerializer.SerializeToUtf8Bytes(new { type = "pong", clientTime = input.ClientTime,
                                received, sent = MediaPacket.Now });
                            await socket.SendAsync(pong, WebSocketMessageType.Text, true, timeout.Token);
                        }
                        finally { sendGate?.Release(); }
                    }
                    continue;
                }
                if (heartbeat.Elapsed > TimeSpan.FromSeconds(10)) throw new IOException("Browser heartbeat expired.");
                await ApplyAsync(source, input, ct);
            }
        }
        finally
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            await ApplyAsync(source, new("reset"), timeout.Token);
        }
    }

    private async Task ApplyAsync(Guid source, SoftwareInput input, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var next = state.Apply(source, input);
            if (sessionId is { } id)
            {
                foreach (var button in next.Buttons.Except(previous.Buttons))
                    await controller.ButtonAsync(id, button, IControllerService.ButtonAction.PRESS, ct: ct);
                foreach (var button in previous.Buttons.Except(next.Buttons))
                    await controller.ButtonAsync(id, button, IControllerService.ButtonAction.RELEASE, ct: ct);
                if (next.Left != previous.Left) await controller.StickAsync(id, "left", point: next.Left, ct: ct);
                if (next.Right != previous.Right) await controller.StickAsync(id, "right", point: next.Right, ct: ct);
                if (next.L2 != previous.L2 || next.R2 != previous.R2)
                    await controller.SetTriggersAsync(id, next.L2, next.R2, ct);
            }
            previous = next;
        }
        finally { gate.Release(); }
    }
}
