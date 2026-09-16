using System.ComponentModel.DataAnnotations;

namespace RemotePlay.Models.Auth
{
    /// <summary>
    /// 用户登录请求模型
    /// </summary>
    public class LoginRequest
    {
        [Required(ErrorMessage = "Username or email is required.")]
        public required string UsernameOrEmail { get; set; }

        [Required(ErrorMessage = "Password is required.")]
        public required string Password { get; set; }
    }
}

