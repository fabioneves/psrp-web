using System.Text.Json;
using RemotePlay.Services;

static class DiagnosticsStoreTests
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        var root = Path.Combine(Path.GetTempPath(), "psrp-diag-" + Guid.NewGuid().ToString("N"));
        try
        {
            var store = new DiagnosticsStore(root);
            var now = new DateTimeOffset(2026, 9, 17, 8, 0, 0, TimeSpan.Zero);
            var capture = JsonDocument.Parse("{\"samples\":[1,2,3]}").RootElement;
            var first = await store.SaveAsync("user/1", capture, now, default);
            var second = await store.SaveAsync("user/1", capture, now, default);
            check(first.Name == "20260917T080000Z.json" && second.Name == "20260917T080000Z-1.json", "captures are named by UTC time and never overwrite each other");
            check(store.List("user/1").Count == 2 && store.List("user/1")[0].Name == second.Name, "listing is newest first and scoped to the account");
            check(store.List("user/2").Count == 0 && store.PathOf("user/2", first.Name) == null, "another account sees nothing");
            check(store.PathOf("user/1", "../" + first.Name) == null && !DiagnosticsStore.ValidName("x.json"), "only well-formed capture names resolve");
            for (var i = 0; i < DiagnosticsStore.Keep + 3; i++) await store.SaveAsync("user/1", capture, now.AddMinutes(i + 1), default);
            check(store.List("user/1").Count == DiagnosticsStore.Keep, $"only the newest {DiagnosticsStore.Keep} captures are kept");
            var failed = false;
            try { await store.SaveAsync("user/1", JsonDocument.Parse("[1]").RootElement, now, default); } catch (ArgumentException) { failed = true; }
            check(failed, "a non-object capture is rejected");
        }
        finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
    }
}
