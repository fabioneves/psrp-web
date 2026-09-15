namespace RemotePlay.Services.Software;

public sealed record VideoProfile(string Resolution, int Width, int Height, int Fps)
{
    public static VideoProfile Create(string resolution, int fps)
    {
        if (fps is not (30 or 60)) throw new ArgumentException("Frame rate must be 30 or 60.");
        return resolution switch
        {
            "360p" => new(resolution, 640, 360, fps),
            "540p" => new(resolution, 960, 540, fps),
            "720p" => new(resolution, 1280, 720, fps),
            "1080p" => new(resolution, 1920, 1080, fps),
            _ => throw new ArgumentException("Resolution must be 360p, 540p, 720p or 1080p.")
        };
    }
}
