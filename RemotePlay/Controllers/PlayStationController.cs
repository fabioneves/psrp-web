
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Newtonsoft.Json.Linq;
using RemotePlay.Contracts.Services;
using RemotePlay.Models.Base;
using RemotePlay.Models.Context;
using RemotePlay.Models.PlayStation;
using RemotePlay.Services;
using RemotePlay.Services.RemotePlay;
using RemotePlay.Services.Streaming.Receiver;
using RemotePlay.Services.Streaming.Controller;
using RemotePlay.Utils;
using System;
using System.Linq;
using System.Security.Claims;

namespace RemotePlay.Controllers
{
    [Route("api/[controller]")]
    [ApiController]
    public class PlayStationController : ControllerBase
    {
        private readonly IRemotePlayService _remotePlayService;
        private readonly ILogger<PlayStationController> _logger;

        private readonly ISessionService _sessionService;
        private readonly IStreamingService _streamingService;
        private readonly IControllerService _controllerService;
        private readonly ILoggerFactory _loggerFactory;
        private readonly IRegisterService _reg;
        private readonly RemotePlay.Services.Device.ConsolePairingStore _pairing;
        private readonly RPContext _rpContext;
        private readonly IWebHostEnvironment _env;
        private readonly IDeviceSettingsService _deviceSettingsService;
        private readonly IdGenerator _idGenerator;

        public PlayStationController(
            IRegisterService registeredServices,
            IRemotePlayService remotePlayService,
            ISessionService sessionService,
            IStreamingService streamingService,
            IControllerService controllerService,
            RPContext rpContext,
            ILogger<PlayStationController> logger,
            ILoggerFactory loggerFactory,
            IWebHostEnvironment env,
            IDeviceSettingsService deviceSettingsService,
            RemotePlay.Services.Device.ConsolePairingStore pairing)
        {
            _remotePlayService = remotePlayService;
            _pairing = pairing;
            _reg = registeredServices;
            _rpContext = rpContext;
            _sessionService = sessionService;
            _streamingService = streamingService;
            _controllerService = controllerService;
            _logger = logger;
            _loggerFactory = loggerFactory;
            _idGenerator = new IdGenerator(0,0);
            _env = env;
            _deviceSettingsService = deviceSettingsService;
        }

        /// <summary>
        /// 发现本地网络中的PlayStation主机
        /// </summary>
        /// <param name="timeoutMs">超时时间（毫秒），默认2000ms</param>
        /// <returns>发现的主机列表</returns>
        [HttpGet("discover")]
        public async Task<ActionResult> DiscoverConsoles(int? timeoutMs = null)
        {
            try
            {
                _logger.LogInformation("开始设备发现，超时时间: {TimeoutMs}ms", timeoutMs ?? 2000);

                var consoles = await _remotePlayService.DiscoverDevicesAsync(timeoutMs, HttpContext.RequestAborted);

                return Ok(new ApiSuccessResponse<object>
                {
                    Success = true,
                    Data = consoles,
                    Message = $"Found {consoles.Count} console(s)."
                });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "设备发现失败");
                return StatusCode(500, new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "Console discovery failed: " + ex.Message,
                    ErrorCode = ErrorCode.DeviceDiscoveryFailed
                });
            }
        }

        /// <summary>
        /// 发现特定IP的PlayStation主机
        /// </summary>
        /// <param name="hostIp">主机IP地址</param>
        /// <param name="timeoutMs">超时时间（毫秒），默认2000ms</param>
        /// <returns>主机信息</returns>
        [HttpGet("discover/{hostIp}")]
        public async Task<ActionResult> DiscoverConsole(string hostIp, int? timeoutMs = null)
        {
            var console = await _remotePlayService.DiscoverDeviceAsync(hostIp, timeoutMs);

            if (console == null)
            {
                return NotFound(new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = $"No console found at {hostIp}.",
                    ErrorCode = ErrorCode.DeviceNotFound
                });
            }

            return Ok(new ApiSuccessResponse<object>
            {
                Success = true,
                Data = console,
                Message = "Console found."
            });
        }

        /// <summary>
        /// wake up console
        /// </summary>
        /// <param name="hostId">console host_id</param>
        /// <returns>status</returns>
        [HttpPost("wakeup")]
        public async Task<ActionResult> WakeUpConsole(string hostId)
        {
            var _device = await _rpContext.PSDevices
                .AsNoTracking()
                .Where(x => x.HostId == hostId && x.IsRegistered == true)
                .FirstOrDefaultAsync();
            if (_device == null)
                return NotFound(new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "Console not found.",
                    ErrorCode = ErrorCode.DeviceNotFound
                });
            if (_device.IpAddress == null)
                return Ok(new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "ip address is empty",
                    ErrorCode = ErrorCode.HostIpRequired
                });
            if (_device.RegistKey == null)
                return Ok(new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "regist_key is empty",
                    ErrorCode = ErrorCode.InvalidRequest
                });
            if (_device.HostType == null)
                return Ok(new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "host_type is empty",
                    ErrorCode = ErrorCode.InvalidRequest
                });
            var _result = await _remotePlayService.WakeUpDeviceAsync(
                _device.IpAddress,
                _device.RegistKey,
                _device.HostType
                );
            return Ok(new ApiSuccessResponse<bool>
            {
                Success = true,
                Data = _result,
                Message = _result ? "Wake request sent." : "Wake request failed."
            });
        }

        /// <summary>
        /// 获取指定设备的串流设置与可用选项
        /// </summary>
        [HttpGet("device-settings/{deviceId}")]
        [Authorize]
        public async Task<ActionResult> GetDeviceSettings(string deviceId, CancellationToken cancellationToken)
        {
            try
            {
                var userId = GetCurrentUserId();
                if (string.IsNullOrEmpty(userId))
                {
                    return Unauthorized(new ApiErrorResponse
                    {
                        Success = false,
                        ErrorMessage = "Not authorized.",
                        ErrorCode = ErrorCode.Unauthorized
                    });
                }

                var response = await _deviceSettingsService.GetDeviceSettingsAsync(userId, deviceId, cancellationToken);

                return Ok(new ApiSuccessResponse<DeviceSettingsResponse>
                {
                    Success = true,
                    Data = response,
                    Message = "Console settings loaded."
                });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "加载设备设置失败");
                if (ex is InvalidOperationException)
                {
                    return NotFound(new ApiErrorResponse
                    {
                        Success = false,
                        ErrorMessage = ex.Message
                    });
                }

                return StatusCode(500, new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "Could not load console settings: " + ex.Message,
                    ErrorCode = ErrorCode.DeviceSettingsLoadFailed
                });
            }
        }

        /// <summary>
        /// 更新指定设备的串流设置
        /// </summary>
        [HttpPost("device-settings/{deviceId}")]
        [Authorize]
        public async Task<ActionResult> UpdateDeviceSettings(string deviceId, [FromBody] UpdateDeviceSettingsRequest request, CancellationToken cancellationToken)
        {
            if (request == null)
            {
                return BadRequest(new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "The request body is required.",
                    ErrorCode = ErrorCode.InvalidRequest
                });
            }

            try
            {
                var userId = GetCurrentUserId();
                if (string.IsNullOrEmpty(userId))
                {
                    return Unauthorized(new ApiErrorResponse
                    {
                        Success = false,
                        ErrorMessage = "Not authorized.",
                        ErrorCode = ErrorCode.Unauthorized
                    });
                }

                var response = await _deviceSettingsService.UpdateDeviceSettingsAsync(userId, deviceId, request, cancellationToken);

                return Ok(new ApiSuccessResponse<DeviceSettingsResponse>
                {
                    Success = true,
                    Data = response,
                    Message = "Console settings saved."
                });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "保存设备设置失败");
                if (ex is InvalidOperationException)
                {
                    return NotFound(new ApiErrorResponse
                    {
                        Success = false,
                        ErrorMessage = ex.Message
                    });
                }

                return StatusCode(500, new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "Could not save console settings: " + ex.Message,
                    ErrorCode = ErrorCode.DeviceSettingsSaveFailed
                });
            }
        }
        /// <summary>
        /// 启动会话
        /// 注意：会话创建后会自动启动流并连接控制器（可通过 SessionStartOptions 配置）
        /// </summary>
        /// <param name="hostId">console host_id</param>
        /// <returns>session</returns>
        [HttpPost("start-session")]
        [Authorize]
        public async Task<ActionResult> StartSession(string hostId)
        {
            var userId = GetCurrentUserId();
            if (string.IsNullOrEmpty(userId))
            {
                return Unauthorized(new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "Not authorized.",
                    ErrorCode = ErrorCode.Unauthorized
                });
            }

            var _device = await _rpContext.PSDevices
                 .AsNoTracking()
                 .Where(x => x.HostId == hostId && x.IsRegistered == true)
                 .FirstOrDefaultAsync();
            if (_device == null)
                return NotFound(new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "Console not found.",
                    ErrorCode = ErrorCode.DeviceNotFound
                });
            if (_device.IpAddress == null)
                return Ok(new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "ip address is empty",
                    ErrorCode = ErrorCode.HostIpRequired
                });
            if (_device.HostType == null)
                return Ok(new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "host_type is empty",
                    ErrorCode = ErrorCode.InvalidRequest
                });

            // 先检查是否已存在活跃的 session
            var existingSessions = await _sessionService.ListSessionsAsync();
            var existingSession = existingSessions
                .FirstOrDefault(s => s.HostId == hostId && s.IsActive);

            RemoteSession _session;
            if (existingSession != null)
            {
                // 返回已存在的活跃 session
                _session = existingSession;
            }
            else
            {
                // 创建新的 session
                var deviceSettings = await _deviceSettingsService.GetEffectiveSettingsAsync(userId, _device.Id, HttpContext.RequestAborted);

                var sessionOptions = new SessionStartOptions
                {
                    Resolution = deviceSettings.Resolution,
                    Fps = deviceSettings.FrameRate,
                    Quality = deviceSettings.Quality,
                    Bitrate = deviceSettings.Bitrate,
                    StreamType = deviceSettings.StreamType,
                    AutoStartStream = true,
                    AutoConnectController = true
                };

                _session = await _sessionService.StartSessionAsync(
                    _device.IpAddress,
                    new()
                    {
                        HostId = _device.HostId,
                        HostName = _device.HostName,
                        HostIp = _device.IpAddress,
                        RegistrationKey = Convert.FromHexString(_device.RegistKey ?? string.Empty),
                        ServerKey = Convert.FromHexString(_device.RPKey ?? string.Empty),
                        CreatedAt = DateTime.UtcNow,
                        ExpiresAt = DateTime.UtcNow.AddDays(30)
                    },
                    _device.HostType,
                    sessionOptions);
            }

            return Ok(new ApiSuccessResponse<object>
            {
                Success = true,
                Data = _session,
                Message = "Session started."
            });
        }

        /// <summary>
        /// stop session
        /// </summary>
        /// <param name="sessionId">session id</param>
        /// <returns>status</returns>
        [HttpPost("stop-session")]
        public async Task<ActionResult> StopSession(Guid sessionId)
        {
            var _session = await _sessionService.StopSessionAsync(sessionId);
            return Ok(new ApiSuccessResponse<bool>
            {
                Success = true,
                Data = _session,
                Message = _session ? "Session stopped." : "Session stop failed."
            });
        }

        /// <summary>
        /// start stream (test or normal)
        /// </summary>
        [HttpPost("start-stream")]
        public async Task<ActionResult> StartStream(Guid sessionId, bool test = true)
        {
            var ok = await _streamingService.StartStreamAsync(sessionId, test);
            return Ok(new ApiSuccessResponse<bool>
            {
                Success = true,
                Data = ok,
                Message = ok ? "Stream started." : "Stream start failed."
            });
        }

        /// <summary>
        /// stop stream
        /// </summary>
        [HttpPost("stop-stream")]
        public async Task<ActionResult> StopStream(Guid sessionId)
        {
            var ok = await _streamingService.StopStreamAsync(sessionId);
            return Ok(new ApiSuccessResponse<bool>
            {
                Success = true,
                Data = ok,
                Message = ok ? "Stream stopped." : "Stream stop failed."
            });
        }

        /// <summary>
        /// attach default receiver (for debugging)
        /// </summary>
        [HttpPost("attach-receiver")]
        public async Task<ActionResult> AttachReceiver(Guid sessionId)
        {
            var receiver = new RemotePlay.Services.Streaming.Receiver.DefaultReceiver(_loggerFactory.CreateLogger<DefaultReceiver>());
            var ok = await _streamingService.AttachReceiverAsync(sessionId, receiver);
            return Ok(new ApiSuccessResponse<bool>
            {
                Success = true,
                Data = ok,
                Message = ok ? "Receiver attached." : "Receiver attach failed."
            });
        }

        /// <summary>
        /// attach file dump receiver (write raw ES to files)
        /// </summary>
        [HttpPost("attach-file-receiver")]
        public async Task<ActionResult> AttachFileReceiver(Guid sessionId, string? videoFile = null, string? audioFile = null)
        {
            var receiver = new RemotePlay.Services.Streaming.Receiver.FileDumpReceiver(videoFile, audioFile);
            var ok = await _streamingService.AttachReceiverAsync(sessionId, receiver);
            return Ok(new ApiSuccessResponse<bool>
            {
                Success = true,
                Data = ok,
                Message = ok ? "File receiver attached." : "File receiver attach failed."
            });
        }

        /// <summary>
        /// attach ffplay receiver (preview video using ffplay)
        /// </summary>
        [HttpPost("attach-ffplay-receiver")]
        public async Task<ActionResult> AttachFfplayReceiver(Guid sessionId, string? ffplayPath = null, string? extraArgs = null)
        {
            var receiver = new RemotePlay.Services.Streaming.Receiver.FfplayVideoReceiver(ffplayPath, extraArgs);
            var ok = await _streamingService.AttachReceiverAsync(sessionId, receiver);
            return Ok(new ApiSuccessResponse<bool>
            {
                Success = true,
                Data = ok,
                Message = ok ? "FFplay receiver attached." : "FFplay receiver attach failed."
            });
        }

        /// <summary>
        /// attach ffmpeg mux receiver (transcode/remux to file or stream)
        /// </summary>
        [HttpPost("attach-ffmpeg-receiver")]
        public async Task<ActionResult> AttachFfmpegReceiver(
            Guid sessionId,
            string? output = null,
            bool enableAudio = true,
            string? ffmpegPath = null,
            string? extraArgs = null,
            bool useTcp = true,
            string? videoCodec = null,
            string? audioCodec = null,
            bool genPts = true,
            bool enableVideo = true)
        {
            var receiver = new RemotePlay.Services.Streaming.Receiver.FfmpegMuxReceiver(output, enableAudio, ffmpegPath, extraArgs, useTcp, videoCodec, audioCodec, genPts, enableVideo);
            var ok = await _streamingService.AttachReceiverAsync(sessionId, receiver);
            return Ok(new ApiSuccessResponse<object>
            {
                Success = true,
                Data = new { success = ok, output },
                Message = ok ? "FFmpeg receiver attached." : "FFmpeg receiver attach failed."
            });
        }

        /// <summary>
        /// 一键开启 HLS 联机分享，返回可访问的 m3u8 地址
        /// </summary>
        [HttpPost("share-hls")]
        public async Task<ActionResult> ShareHls(
            Guid sessionId,
            int segmentTime = 2,
            int listSize = 6,
            bool enableAudio = false,
            bool useTcp = true,
            bool enableVideo = true)  // 是否输出视频（false = 纯音频模式，节省带宽）
        {
            _logger.LogInformation("开始设置 HLS 推流 - SessionId: {SessionId}, TCP: {UseTcp}, Video: {Video}, Audio: {Audio}", 
                sessionId, useTcp, enableVideo, enableVideo ? enableAudio : true);

            // 使用 WebRoot 确保静态文件中可见
            var webRoot = _env.WebRootPath;
            if (string.IsNullOrEmpty(webRoot))
            {
                webRoot = Path.Combine(Directory.GetCurrentDirectory(), "wwwroot");
            }
            Directory.CreateDirectory(webRoot);
            var absDir = Path.Combine(webRoot, "hls", sessionId.ToString("N"));
            Directory.CreateDirectory(absDir);
            var m3u8 = Path.Combine(absDir, "index.m3u8");

            _logger.LogInformation("📁 HLS 输出目录: {Dir}", absDir);
            _logger.LogInformation("📋 M3U8 文件: {M3u8}", m3u8);

            // 构造 HLS 额外参数
            var segPattern = Path.Combine(absDir, "seg_%05d.ts");
            // 添加错误容忍参数：
            // -err_detect ignore_err: 忽略解码错误
            // -max_muxing_queue_size 9999: 增大缓冲队列
            // -fps_mode passthrough: 保持原始帧率，不丢弃帧
            var extraArgs = $"-err_detect ignore_err -max_muxing_queue_size 9999 -fps_mode passthrough -f hls -hls_time {segmentTime} -hls_list_size {listSize} -hls_flags delete_segments+program_date_time -hls_segment_filename '{segPattern.Replace("'", "'\\''")}'";

            var ffmpegLogger = _loggerFactory.CreateLogger<FfmpegMuxReceiver>();
            var receiver = new RemotePlay.Services.Streaming.Receiver.FfmpegMuxReceiver(
                output: m3u8,
                enableAudio: enableVideo ? enableAudio : true,  // 纯音频模式强制启用音频
                ffmpegPath: null,
                extraArgs: extraArgs,
                useTcp: useTcp,
                videoCodec: null,
                audioCodec: null,
                genPts: true,
                enableVideo: enableVideo,
                logger: ffmpegLogger);

            var ok = await _streamingService.AttachReceiverAsync(sessionId, receiver);
            if (!ok)
            {
                _logger.LogError("❌ 绑定 HLS 接收器失败 - SessionId: {SessionId}", sessionId);
                return Ok(new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "Could not attach the HLS receiver. Make sure the stream is running and retry.",
                    ErrorCode = ErrorCode.StreamNotFound
                });
            }

            _logger.LogInformation("✅ HLS 接收器已绑定成功");

            // 返回可直接访问的 URL（静态文件已启用）
            var publicUrl = $"/hls/{sessionId:N}/index.m3u8";
            return Ok(new ApiSuccessResponse<object>
            {
                Success = true,
                Data = new { url = publicUrl },
                Message = "HLS sharing started."
            });
        }

        /// <summary>
        /// get session
        /// </summary>
        /// <param name="sessionId">session id</param>
        /// <returns>session</returns>
        [HttpGet("get-session")]
        public async Task<ActionResult> GetSession(Guid sessionId)
        {
            var _session = await _sessionService.GetSessionAsync(sessionId);
            return Ok(new ApiSuccessResponse<object>
            {
                Success = true,
                Data = _session,
                Message = "Session retrieved."
            });
        }
        /// <summary>
        /// 注册设备到PlayStation主机
        /// </summary>
        /// <param name="request">注册请求</param>
        /// <returns>注册结果</returns>
        [HttpPost("register")]
        public async Task<ActionResult> RegisterDevice([FromBody] RegisterDeviceRequest request)
        {
            try
            {
                if (string.IsNullOrEmpty(request.HostIp))
                    return BadRequest(new ApiErrorResponse
                    {
                        Success = false,
                        ErrorMessage = "The console IP address is required.",
                        ErrorCode = ErrorCode.HostIpRequired
                    });

                if (string.IsNullOrEmpty(request.AccountId))
                    return BadRequest(new ApiErrorResponse
                    {
                        Success = false,
                        ErrorMessage = "The PSN account ID is required.",
                        ErrorCode = ErrorCode.AccountIdRequired
                    });

                if (string.IsNullOrEmpty(request.Pin))
                    return BadRequest(new ApiErrorResponse
                    {
                        Success = false,
                        ErrorMessage = "The PIN is required.",
                        ErrorCode = ErrorCode.PinRequired
                    });

                _logger.LogInformation("开始设备注册 - 主机: {HostIp}, 账户: {AccountId}", request.HostIp, request.AccountId);

                var result = await _remotePlayService.RegisterDeviceAsync(request.HostIp, request.AccountId, request.Pin);

                if (result.Success)
                {
                    return Ok(new ApiSuccessResponse<object>
                    {
                        Success = true,
                        Data = result,
                        Message = "Console paired."
                    });
                }
                else
                {
                    return Ok(new ApiErrorResponse
                    {
                        Success = false,
                        ErrorMessage = result.ErrorMessage ?? "Console pairing failed."
                    });
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "设备注册失败");
                return StatusCode(500, new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "Console pairing failed: " + ex.Message,
                    ErrorCode = ErrorCode.DeviceRegistrationFailed
                });
            }
        }

        /// <summary>
        /// 验证设备凭据
        /// </summary>
        /// <param name="credentials">设备凭据</param>
        /// <returns>验证结果</returns>
        [HttpPost("validate-credentials")]
        public async Task<ActionResult> ValidateCredentials([FromBody] DeviceCredentials credentials)
        {
            try
            {
                if (credentials == null)
                    return BadRequest(new ApiErrorResponse
                    {
                        Success = false,
                        ErrorMessage = "Credentials are required.",
                        ErrorCode = ErrorCode.CredentialRequired
                    });

                _logger.LogInformation("验证设备凭据 - 主机: {HostName}", credentials.HostName);

                var isValid = await _remotePlayService.ValidateCredentialsAsync(credentials);

                return Ok(new ApiSuccessResponse<bool>
                {
                    Success = true,
                    Data = isValid,
                    Message = isValid ? "Credentials are valid." : "Credentials are invalid or expired."
                });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "验证凭据失败");
                return StatusCode(500, new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "Credential check failed: " + ex.Message,
                    ErrorCode = ErrorCode.InternalServerError
                });
            }
        }

        [HttpGet("test")]
        public ActionResult TestEncoding(string hostType, string hostIp, string psnId, string pin)
        {
            var (chsper, headers, playload) = _reg.GetRegistCipherHeadersPayload(hostType, hostIp, psnId, pin);

            return Ok(new ApiSuccessResponse<object>
            {
                Success = true,
                Data = new
                {
                    chsper = chsper,
                    headers = headers,
                    playload = playload
                },
                Message = "Test encoding succeeded."
            });
        }

        #region 控制器相关接口

        /// <summary>
        /// 连接控制器到会话
        /// </summary>
        [HttpPost("controller/connect")]
        public async Task<ActionResult> ConnectController(Guid sessionId)
        {
            var success = await _controllerService.ConnectAsync(sessionId);
            return Ok(new ApiSuccessResponse<bool>
            {
                Success = true,
                Data = success,
                Message = success ? "Controller connected." : "Controller connection failed."
            });
        }

        /// <summary>
        /// 断开控制器连接
        /// </summary>
        [HttpPost("controller/disconnect")]
        public async Task<ActionResult> DisconnectController(Guid sessionId)
        {
            await _controllerService.DisconnectAsync(sessionId);
            return Ok(new ApiSuccessResponse<bool>
            {
                Success = true,
                Data = true,
                Message = "Controller disconnected."
            });
        }

        /// <summary>
        /// 启动控制器（开始自动发送摇杆状态）
        /// </summary>
        [HttpPost("controller/start")]
        public async Task<ActionResult> StartController(Guid sessionId)
        {
            var success = await _controllerService.StartAsync(sessionId);
            return Ok(new ApiSuccessResponse<bool>
            {
                Success = true,
                Data = success,
                Message = success ? "Controller started." : "Controller start failed."
            });
        }

        /// <summary>
        /// 停止控制器
        /// </summary>
        [HttpPost("controller/stop")]
        public async Task<ActionResult> StopController(Guid sessionId)
        {
            await _controllerService.StopAsync(sessionId);
            return Ok(new ApiSuccessResponse<bool>
            {
                Success = true,
                Data = true,
                Message = "Controller stopped."
            });
        }

        /// <summary>
        /// 按键操作
        /// </summary>
        [HttpPost("controller/button")]
        public async Task<ActionResult> ControllerButton(
            [FromBody] ControllerButtonRequest request)
        {
            if (!Enum.TryParse<FeedbackEvent.ButtonType>(
                request.Button.ToUpper(), out var buttonType))
            {
                return BadRequest(new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = $"Invalid button: {request.Button}. Available buttons: {string.Join(", ", _controllerService.GetAvailableButtons())}"
                });
            }

            var action = request.Action?.ToLower() switch
            {
                "press" => IControllerService.ButtonAction.PRESS,
                "release" => IControllerService.ButtonAction.RELEASE,
                "tap" => IControllerService.ButtonAction.TAP,
                _ => IControllerService.ButtonAction.TAP
            };

            await _controllerService.ButtonAsync(
                request.SessionId,
                buttonType,
                action,
                request.DelayMs ?? 100);

            return Ok(new ApiSuccessResponse<bool>
            {
                Success = true,
                Data = true,
                Message = "Button sent."
            });
        }

        /// <summary>
        /// 设置摇杆状态
        /// </summary>
        [HttpPost("controller/stick")]
        public async Task<ActionResult> ControllerStick(
            [FromBody] ControllerStickRequest request)
        {
            try
            {
                (float x, float y)? point = null;
                if (request.Point != null)
                {
                    point = (request.Point.X, request.Point.Y);
                }

                await _controllerService.StickAsync(
                    request.SessionId,
                    request.StickName,
                    request.Axis,
                    request.Value,
                    point);

                return Ok(new ApiSuccessResponse<bool>
                {
                    Success = true,
                    Data = true,
                    Message = "Stick updated."
                });
            }
            catch (Exception ex)
            {
                return BadRequest(new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = ex.Message
                });
            }
        }

        /// <summary>
        /// 设置扳机压力
        /// </summary>
        [HttpPost("controller/trigger")]
        public async Task<ActionResult> ControllerTrigger(
            [FromBody] ControllerTriggerRequest request)
        {
            if (request == null || (!request.L2.HasValue && !request.R2.HasValue))
            {
                return BadRequest(new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "Provide a value for L2 or R2.",
                    ErrorCode = ErrorCode.TriggerValueRequired
                });
            }

            await _controllerService.SetTriggersAsync(request.SessionId, request.L2, request.R2);

            return Ok(new ApiSuccessResponse<bool>
            {
                Success = true,
                Data = true,
                Message = "Triggers updated."
            });
        }

        /// <summary>
        /// 获取当前摇杆状态
        /// </summary>
        [HttpGet("controller/state")]
        public ActionResult GetControllerState(Guid sessionId)
        {
            var state = _controllerService.GetStickState(sessionId);
            if (state == null)
            {
                return NotFound(new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "Controller not connected.",
                    ErrorCode = ErrorCode.ControllerNotConnected
                });
            }

            return Ok(new ApiSuccessResponse<object>
            {
                Success = true,
                Data = new
                {
                    left = new { x = state.Left.X, y = state.Left.Y },
                    right = new { x = state.Right.X, y = state.Right.Y },
                    triggers = new { l2 = state.L2State / 255f, r2 = state.R2State / 255f }
                },
                Message = "Controller state retrieved."
            });
        }

        /// <summary>
        /// 获取所有可用按键
        /// </summary>
        [HttpGet("controller/buttons")]
        public ActionResult GetAvailableButtons()
        {
            var buttons = _controllerService.GetAvailableButtons();
            return Ok(new ApiSuccessResponse<object>
            {
                Success = true,
                Data = buttons,
                Message = "Available buttons retrieved."
            });
        }

        /// <summary>
        /// 检查控制器状态
        /// </summary>
        [HttpGet("controller/status")]
        public ActionResult GetControllerStatus(Guid sessionId)
        {
            return Ok(new ApiSuccessResponse<object>
            {
                Success = true,
                Data = new
                {
                    isRunning = _controllerService.IsRunning(sessionId),
                    isReady = _controllerService.IsReady(sessionId)
                },
                Message = "Controller state retrieved."
            });
        }

        #endregion

        private string? GetCurrentUserId() => User.FindFirst(ClaimTypes.NameIdentifier)?.Value;

        #region 设备绑定相关接口

        /// <summary>
        /// 绑定PS主机到当前用户
        /// </summary>
        /// <param name="request">绑定请求</param>
        /// <returns>绑定结果</returns>
        [HttpPost("bind")]
        [Authorize]
        public async Task<ActionResult> BindDevice([FromBody] BindDeviceRequest request)
        {
            if (string.IsNullOrWhiteSpace(request.AccountId) || string.IsNullOrWhiteSpace(request.Pin))
                return BadRequest(new { message = "Account ID and console pairing PIN are required." });

            try
            {
                // 获取当前用户ID
                var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
                if (string.IsNullOrEmpty(userIdClaim))
                {
                    return Unauthorized(new ApiErrorResponse
                    {
                        Success = false,
                        ErrorMessage = "Not authorized.",
                        ErrorCode = ErrorCode.Unauthorized
                    });
                }

                // 验证输入参数
                if (string.IsNullOrEmpty(request.HostIp))
                    return BadRequest(new ApiErrorResponse
                    {
                        Success = false,
                        ErrorMessage = "The console IP address is required.",
                        ErrorCode = ErrorCode.HostIpRequired
                    });

                // 如果提供了账户ID和PIN，则进行注册
                RegisterResult? registerResult = null;
                if (!string.IsNullOrEmpty(request.AccountId) && !string.IsNullOrEmpty(request.Pin))
                {
                    _logger.LogInformation("开始设备注册 - 主机: {HostIp}, 账户: {AccountId}", request.HostIp, request.AccountId);
                    registerResult = await _remotePlayService.RegisterDeviceAsync(request.HostIp, request.AccountId, request.Pin);
                    
                    if (!registerResult.Success)
                    {
                        return Ok(new ApiErrorResponse
                        {
                            Success = false,
                            ErrorMessage = "Console pairing failed: " + registerResult.ErrorMessage,
                            ErrorCode = ErrorCode.DeviceRegistrationFailed
                        });
                    }
                }

                // 发现设备获取详细信息
                ConsoleInfo? deviceInfo = await _remotePlayService.DiscoverDeviceAsync(request.HostIp);

                if (deviceInfo == null)
                {
                    return BadRequest(new ApiErrorResponse
                    {
                        Success = false,
                        ErrorMessage = "Console not found. Make sure it is on and connected to the same network.",
                        ErrorCode = ErrorCode.DeviceDiscoveryFailed
                    });
                }

                var device = await _pairing.SaveAsync(userIdClaim, deviceInfo, registerResult!, request.DeviceName, HttpContext.RequestAborted);

                return Ok(new ApiSuccessResponse<object>
                {
                    Success = true,
                    Data = new
                    {
                        deviceId = device.Id,
                        hostId = device.HostId,
                        hostName = device.HostName,
                        hostType = device.HostType,
                        ipAddress = device.IpAddress,
                        isRegistered = device.IsRegistered
                    },
                    Message = "Console paired to your account."
                });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "设备绑定失败");
                return StatusCode(500, new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "Console pairing failed: " + ex.Message,
                    ErrorCode = ErrorCode.DeviceBindingFailed
                });
            }
        }

        /// <summary>
        /// 获取当前用户已绑定的设备列表
        /// </summary>
        /// <returns>设备列表</returns>
        [HttpGet("my-devices")]
        [Authorize]
        public async Task<ActionResult> GetMyDevices()
        {
            try
            {
                var userId = GetCurrentUserId();
                if (string.IsNullOrEmpty(userId))
                {
                    return Unauthorized(new
                    {
                        success = false,
                        statusCode = 401,
                        message = "Not authorized."
                    });
                }

                var devices = await _deviceSettingsService.GetUserDevicesAsync(userId, HttpContext.RequestAborted);

                return Ok(new ApiSuccessResponse<object>
                {
                    Success = true,
                    Data = devices,
                    Message = $"Found {devices.Count} paired console(s)."
                });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "获取用户设备列表失败");
                return StatusCode(500, new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "Could not list consoles: " + ex.Message,
                    ErrorCode = ErrorCode.InternalServerError
                });
            }
        }

        /// <summary>
        /// 解绑设备
        /// </summary>
        /// <param name="userDeviceId">用户设备关联ID</param>
        /// <returns>解绑结果</returns>
        [HttpPost("unbind")]
        [Authorize]
        public async Task<ActionResult> UnbindDevice(string userDeviceId)
        {
            try
            {
                var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
                if (string.IsNullOrEmpty(userIdClaim))
                {
                    return Unauthorized(new ApiErrorResponse
                    {
                        Success = false,
                        ErrorMessage = "Not authorized.",
                        ErrorCode = ErrorCode.Unauthorized
                    });
                }

                var userDevice = await _rpContext.UserDevices
                    .FirstOrDefaultAsync(ud => ud.Id == userDeviceId && ud.UserId == userIdClaim);

                if (userDevice == null)
                {
                    return NotFound(new ApiErrorResponse
                    {
                        Success = false,
                        ErrorMessage = "That console is not paired to your account.",
                        ErrorCode = ErrorCode.NotFound
                    });
                }

                userDevice.IsActive = false;
                userDevice.UpdatedAt = DateTime.UtcNow;
                await _rpContext.SaveChangesAsync();

                return Ok(new ApiSuccessResponse<bool>
                {
                    Success = true,
                    Data = true,
                    Message = "Console removed."
                });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "设备解绑失败");
                return StatusCode(500, new ApiErrorResponse
                {
                    Success = false,
                    ErrorMessage = "Could not remove the console: " + ex.Message,
                    ErrorCode = ErrorCode.InternalServerError
                });
            }
        }

        #endregion
    }

    public class ControllerButtonRequest
    {
        public Guid SessionId { get; set; }
        public string Button { get; set; } = string.Empty;
        public string? Action { get; set; } = "tap";  // press, release, tap
        public int? DelayMs { get; set; } = 100;
    }

    public class ControllerStickRequest
    {
        public Guid SessionId { get; set; }
        public string StickName { get; set; } = string.Empty;  // left, right
        public string? Axis { get; set; }  // x, y
        public float? Value { get; set; }  // -1.0 to 1.0
        public StickPoint? Point { get; set; }
    }

    public class StickPoint
    {
        public float X { get; set; }
        public float Y { get; set; }
    }

    public class RegisterDeviceRequest
    {
        public string HostIp { get; set; } = string.Empty;
        public string AccountId { get; set; } = string.Empty;
        public string Pin { get; set; } = string.Empty;
    }

    public class BindDeviceRequest
    {
        public string HostIp { get; set; } = string.Empty;
        public string? AccountId { get; set; }
        public string? Pin { get; set; }
        public string? DeviceName { get; set; }
    }

}
