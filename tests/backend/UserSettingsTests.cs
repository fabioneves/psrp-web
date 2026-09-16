using System.Text.Json;
using RemotePlay.Services.Auth;

static class UserSettingsTests
{
    public static void Run(Action<bool, string> check)
    {
        check(UserSettingsStore.Validate(JsonDocument.Parse("{\"preferences\":{\"volume\":\"0.8\"}}").RootElement) == null, "a settings object is accepted");
        check(UserSettingsStore.Validate(JsonDocument.Parse("[1,2]").RootElement) != null && UserSettingsStore.Validate(JsonDocument.Parse("\"x\"").RootElement) != null, "non-object settings are rejected");
        var big = "{\"pad\":\"" + new string('x', UserSettingsStore.MaxBytes) + "\"}";
        check(UserSettingsStore.Validate(JsonDocument.Parse(big).RootElement)?.Contains("KB") == true, "oversized settings are rejected with the limit named");
    }
}
