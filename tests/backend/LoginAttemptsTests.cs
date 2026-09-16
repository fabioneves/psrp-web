using RemotePlay.Services.Auth;

static class LoginAttemptsTests
{
    public static void Run(Action<bool, string> check)
    {
        var clock = new TestClock();
        var attempts = new LoginAttempts(clock);
        for (var i = 0; i < 4; i++) attempts.Failed("alice", "10.0.0.5");
        check(attempts.Blocked("alice", "10.0.0.5") == null, "four failures leave the account open");
        attempts.Failed("alice", "10.0.0.5");
        var wait = attempts.Blocked("alice", "10.0.0.5");
        check(wait is { } w && w > TimeSpan.FromSeconds(55) && w <= TimeSpan.FromMinutes(1), "the fifth failure locks the account for a minute");
        check(attempts.Blocked("ALICE", "10.0.0.9") != null, "the lock follows the account regardless of case or address");
        check(attempts.Blocked("bob", "10.0.0.5") == null, "another account from the same address is not locked by five failures");
        clock.Now += TimeSpan.FromMinutes(1);
        check(attempts.Blocked("alice", "10.0.0.5") == null, "the lock expires");
        attempts.Failed("alice", "10.0.0.5");
        check(attempts.Blocked("alice", "10.0.0.5") is { } doubled && doubled > TimeSpan.FromMinutes(1.9), "each further failure doubles the lock");
        attempts.Succeeded("alice");
        check(attempts.Blocked("alice", "10.0.0.5") == null, "a successful sign-in clears the account counter");
        for (var i = 0; i < LoginAttempts.AddressFailures; i++) attempts.Failed($"user{i}", "203.0.113.7");
        check(attempts.Blocked("someone", "203.0.113.7") is { } address && address > TimeSpan.FromMinutes(9), "twenty failures from one address lock that address for ten minutes");
        check(attempts.Blocked("someone", "203.0.113.8") == null, "other addresses are unaffected");
        clock.Now += TimeSpan.FromMinutes(30);
        check(attempts.Blocked("someone", "203.0.113.7") == null && attempts.Blocked("alice", "10.0.0.5") == null, "quiet counters are pruned");
    }
}
