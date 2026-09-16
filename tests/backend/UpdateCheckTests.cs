using RemotePlay.Services;

static class UpdateCheckTests
{
    public static void Run(Action<bool, string> check)
    {
        check(!UpdateCheck.IsUpdate("abc1234", "abc1234def0000000000000000000000000000000"), "a build whose hash prefixes the newest commit is current");
        check(UpdateCheck.IsUpdate("abc1234", "0123456789abcdef0123456789abcdef01234567"), "a different newest commit means an update is available");
        check(!UpdateCheck.IsUpdate("dev", "0123456789abcdef0123456789abcdef01234567") && !UpdateCheck.IsUpdate("abc1234", null) && !UpdateCheck.IsUpdate("abc1234", "abc"), "dev builds, failed checks and short hashes never report an update");
    }
}
