using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using RemotePlay.Contracts.Services;
using RemotePlay.Models.Auth;
using RemotePlay.Models.Base;
using RemotePlay.Models.Context;
using RemotePlay.Services.Auth;
using Microsoft.EntityFrameworkCore;

namespace RemotePlay.Controllers
{
    /// <summary>
    /// 认证控制器
    /// </summary>
    [ApiController]
    [Route("api/[controller]")]
    public class AuthController : ControllerBase
    {
        private readonly IAuthService _authService;
        private readonly ILogger<AuthController> _logger;
        private readonly RPContext _db;

        public AuthController(
            IAuthService authService,
            ILogger<AuthController> logger,
            RPContext db,
            LoginAttempts attempts)
        {
            _authService = authService;
            _logger = logger;
            _db = db;
            _attempts = attempts;
        }
        private readonly LoginAttempts _attempts;
        private string ClientAddress => HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";

        private static bool RegistrationAllowedByConfiguration =>
            string.Equals(Environment.GetEnvironmentVariable("ALLOW_REGISTRATION"), "true", StringComparison.OrdinalIgnoreCase);

        /// <summary>
        /// First-run state: whether any account exists and whether registration is open.
        /// </summary>
        [HttpGet("setup")]
        [AllowAnonymous]
        public async Task<IActionResult> Setup()
        {
            Response.Headers.CacheControl = "no-store";
            var hasUsers = await _db.Users.AnyAsync();
            return Ok(new { needsSetup = !hasUsers, registrationOpen = !hasUsers || RegistrationAllowedByConfiguration || User.Identity?.IsAuthenticated == true });
        }

        /// <summary>
        /// 用户注册
        /// </summary>
        [HttpPost("register")]
        [AllowAnonymous]
        public async Task<ActionResult<ResponseModel>> Register([FromBody] RegisterRequest request)
        {
            try
            {
                if (!ModelState.IsValid)
                {
                    return BadRequest(new ApiErrorResponse
                    {
                        Success = false,
                        ErrorMessage = "The request failed validation.",
                        ErrorCode = ErrorCode.InvalidRequest
                    });
                }

                if (await _db.Users.AnyAsync() && !RegistrationAllowedByConfiguration && User.Identity?.IsAuthenticated != true)
                {
                    return StatusCode(403, new ApiErrorResponse
                    {
                        Success = false,
                        ErrorMessage = "Registration is closed on this server. Sign in with an existing account, or set ALLOW_REGISTRATION=true to open it.",
                        ErrorCode = ErrorCode.Unauthorized
                    });
                }

                var response = await _authService.RegisterAsync(request);

                return Ok(new ApiSuccessResponse<object>
                {
                    Success = true,
                    Data = response,
                    Message = "Account created."
                });
            }
            catch (InvalidOperationException ex)
            {
                return BadRequest(new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = ex.Message
                });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "用户注册失败");
                return StatusCode(500, new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "Internal server error.",
                    ErrorCode = ErrorCode.InternalServerError
                });
            }
        }

        /// <summary>
        /// 用户登录
        /// </summary>
        [HttpPost("login")]
        [AllowAnonymous]
        public async Task<ActionResult<ResponseModel>> Login([FromBody] LoginRequest request)
        {
            if (Request.Headers.ContainsKey("X-Remote-Play-Session") && !BrowserSession.IsSameOrigin(Request))
                return StatusCode(403);
            try
            {
                if (!ModelState.IsValid)
                {
                    return BadRequest(new ApiErrorResponse
                    {
                        Success = false,
                        ErrorMessage = "The request failed validation.",
                        ErrorCode = ErrorCode.InvalidRequest
                    });
                }

                var account = request.UsernameOrEmail.Trim();
                if (_attempts.Blocked(account, ClientAddress) is { } wait)
                {
                    var seconds = (int)Math.Ceiling(wait.TotalSeconds);
                    Response.Headers.RetryAfter = seconds.ToString();
                    return StatusCode(429, new ApiErrorResponse
                    {
                        Success = false,
                        ErrorMessage = $"Too many sign-in attempts. Try again in {(seconds >= 120 ? $"{seconds / 60} minutes" : $"{seconds} seconds")}.",
                        ErrorCode = ErrorCode.LoginFailed
                    });
                }

                var response = await _authService.LoginAsync(request);

                if (response == null)
                {
                    _attempts.Failed(account, ClientAddress);
                    return Unauthorized(new ApiErrorResponse
                    {
                        Success = false,
                        ErrorMessage = "Wrong username or password.",
                        ErrorCode = ErrorCode.InvalidCredentials
                    });
                }
                _attempts.Succeeded(account);

                Response.Headers.CacheControl = "no-store";
                if (BrowserSession.CanPersistLogin(Request))
                    Response.Cookies.Append(BrowserSession.CookieName, response.Token,
                        BrowserSession.Options(Request, new DateTimeOffset(response.ExpiresAt)));

                return Ok(new ApiSuccessResponse<object>
                {
                    Success = true,
                    Data = response,
                    Message = "Signed in."
                });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "用户登录失败");
                return StatusCode(500, new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "Internal server error.",
                    ErrorCode = ErrorCode.InternalServerError
                });
            }
        }

        [HttpGet("session")]
        [AllowAnonymous]
        public async Task<IActionResult> RestoreSession()
        {
            Response.Headers.CacheControl = "no-store";
            if (!BrowserSession.IsSameOrigin(Request)) return StatusCode(403);
            var token = Request.Cookies[BrowserSession.CookieName];
            if (token != null)
            {
                var user = await _authService.ValidateTokenAsync(token);
                if (user?.IsActive == true) return Ok(new { token });
                Response.Cookies.Delete(BrowserSession.CookieName, BrowserSession.Options(Request));
            }
            return Ok(new { token = (string?)null });
        }

        [HttpPost("logout")]
        [AllowAnonymous]
        public IActionResult Logout()
        {
            Response.Headers.CacheControl = "no-store";
            if (!BrowserSession.IsSameOrigin(Request)) return StatusCode(403);
            Response.Cookies.Delete(BrowserSession.CookieName, BrowserSession.Options(Request));
            return Ok(new { success = true });
        }

        /// <summary>
        /// 获取当前用户信息（用于测试）
        /// </summary>
        [HttpGet("me")]
        [Authorize]
        public async Task<ActionResult<ResponseModel>> GetCurrentUser()
        {
            try
            {
                var userIdClaim = User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value;
                if (string.IsNullOrEmpty(userIdClaim))
                {
                    return Unauthorized(new ApiErrorResponse
                    {
                        Success = false,
                        ErrorMessage = "Could not load the user profile.",
                        ErrorCode = ErrorCode.Unauthorized
                    });
                }

                var user = await _authService.FindUserByIdAsync(userIdClaim);
                if (user == null)
                {
                    // 如果找不到用户，尝试从Claims获取信息
                    var username = User.FindFirst(System.Security.Claims.ClaimTypes.Name)?.Value;
                    var email = User.FindFirst(System.Security.Claims.ClaimTypes.Email)?.Value;

                    return Ok(new ApiSuccessResponse<object>
                    {
                        Success = true,
                        Data = new
                        {
                            Username = username,
                            Email = email,
                            UserId = userIdClaim
                        },
                        Message = "Token is valid."
                    });
                }

                return Ok(new ApiSuccessResponse<object>
                {
                    Success = true,
                    Data = new
                    {
                        UserId = user.Id,
                        Username = user.Username,
                        Email = user.Email,
                        LastLoginAt = user.LastLoginAt,
                        CreatedAt = user.CreatedAt
                    },
                    Message = "Token is valid."
                });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "获取用户信息失败");
                return StatusCode(500, new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "Internal server error.",
                    ErrorCode = ErrorCode.InternalServerError
                });
            }
        }
    }
}
