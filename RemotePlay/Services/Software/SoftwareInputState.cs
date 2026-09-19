using RemotePlay.Services.Streaming.Controller;

namespace RemotePlay.Services.Software;

public sealed record SoftwareInput(string Type, string? Button = null, bool Pressed = false,
    string? Stick = null, float X = 0, float Y = 0, float L2 = 0, float R2 = 0, double ClientTime = 0,
    System.Text.Json.JsonElement? Sample = null, System.Text.Json.JsonElement? Events = null, string? Sdp = null);

public sealed class SoftwareInputState
{
    public sealed class State
    {
        public HashSet<FeedbackEvent.ButtonType> Buttons { get; } = [];
        public (float X, float Y) Left { get; set; }
        public (float X, float Y) Right { get; set; }
        public float L2 { get; set; }
        public float R2 { get; set; }
    }

    private readonly Dictionary<Guid, State> sources = [];

    public State Apply(Guid source, SoftwareInput input)
    {
        if (!sources.TryGetValue(source, out var state)) sources[source] = state = new();
        switch (input.Type)
        {
            case "button" when Enum.TryParse<FeedbackEvent.ButtonType>(input.Button, out var button) && Enum.IsDefined(button):
                if (input.Pressed) state.Buttons.Add(button); else state.Buttons.Remove(button);
                break;
            case "stick" when input.Stick is "left" or "right" && float.IsFinite(input.X) && float.IsFinite(input.Y):
                var point = (Math.Clamp(input.X, -1, 1), Math.Clamp(input.Y, -1, 1));
                if (input.Stick == "left") state.Left = point; else state.Right = point;
                break;
            case "triggers" when float.IsFinite(input.L2) && float.IsFinite(input.R2):
                state.L2 = Math.Clamp(input.L2, 0, 1);
                state.R2 = Math.Clamp(input.R2, 0, 1);
                break;
            case "reset": sources.Remove(source); break;
            default: throw new IOException("Unknown or invalid input command.");
        }
        var merged = new State();
        foreach (var held in sources.Values)
        {
            merged.Buttons.UnionWith(held.Buttons);
            if (Magnitude(held.Left) > Magnitude(merged.Left)) merged.Left = held.Left;
            if (Magnitude(held.Right) > Magnitude(merged.Right)) merged.Right = held.Right;
            merged.L2 = Math.Max(merged.L2, held.L2);
            merged.R2 = Math.Max(merged.R2, held.R2);
        }
        if (merged.Buttons.Contains(FeedbackEvent.ButtonType.L2)) merged.L2 = 1;
        if (merged.Buttons.Contains(FeedbackEvent.ButtonType.R2)) merged.R2 = 1;
        if (merged.L2 > 0) merged.Buttons.Add(FeedbackEvent.ButtonType.L2);
        if (merged.R2 > 0) merged.Buttons.Add(FeedbackEvent.ButtonType.R2);
        return merged;
    }

    private static float Magnitude((float X, float Y) point) => point.X * point.X + point.Y * point.Y;
}
