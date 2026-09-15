using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace RemotePlay.Services.Auth;

public sealed class PsnNative
{
    private readonly SemaphoreSlim gate = new(1, 1);
    public async Task<JsonDocument> RunAsync(object request, CancellationToken ct)
    {
        if (!await gate.WaitAsync(0, ct)) throw new PsnSetupException(409, "Another PSN pairing request is running. Please wait a moment.");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(75));
        using var process = new Process { StartInfo = new ProcessStartInfo("/app/remote-play-psn")
            { UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true } };
        var started = false;
        Task<string>? output = null, errors = null;
        try
        {
            process.Start();
            started = true;
            output = ReadAsync(process.StandardOutput, 65536, deadline.Token);
            errors = ReadAsync(process.StandardError, 4096, deadline.Token);
            await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(request).AsMemory(), deadline.Token);
            process.StandardInput.Close();
            await process.WaitForExitAsync(deadline.Token);
            await errors;
            var json = await output;
            if (process.ExitCode != 0) throw new PsnSetupException(409, "Automatic pairing could not complete. Make sure Remote Play is enabled and this PSN account is on the console, or pair with a PIN.");
            return JsonDocument.Parse(json);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        { throw new PsnSetupException(504, "Automatic pairing timed out. Please try again or pair with a PIN."); }
        catch (System.ComponentModel.Win32Exception)
        { throw new PsnSetupException(503, "Automatic pairing is not available on this server. Pair with a PIN instead."); }
        finally
        {
            if (started && !process.HasExited) { process.Kill(true); await process.WaitForExitAsync(CancellationToken.None); }
            if (output != null && errors != null)
                try { await Task.WhenAll(output, errors); } catch { }
            gate.Release();
        }
    }

    private static async Task<string> ReadAsync(StreamReader stream, int limit, CancellationToken ct)
    {
        var result = new StringBuilder();
        var buffer = new char[2048];
        int count;
        while ((count = await stream.ReadAsync(buffer, ct)) > 0)
        {
            if (result.Length + count > limit) throw new IOException("PSN helper response exceeded its limit.");
            result.Append(buffer, 0, count);
        }
        return result.ToString();
    }
}
