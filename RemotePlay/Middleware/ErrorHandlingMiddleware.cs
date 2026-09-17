using Newtonsoft.Json;

namespace RemotePlay.Utils
{
    public class ErrorHandlingMiddleware
    {
        private readonly RequestDelegate next;

        public ErrorHandlingMiddleware(RequestDelegate next)
        {
            this.next = next;
        }

        public async Task Invoke(HttpContext context)
        {
            try
            {
                await next(context);
            }
            catch (Exception ex)
            {
                // 如果响应已开始，不要覆盖
                if (context.Response.HasStarted)
                {
                    return;
                }

                var statusCode = ex is ArgumentException ? 400 : 500;
                await HandleExceptionAsync(context, statusCode, statusCode == 400 ? ex.Message : "The request failed. Check the server logs.");
                return; // 异常已处理，不需要再处理状态码
            }
            
            // 如果响应已开始（例如静态文件已成功提供），则不处理错误
            if (context.Response.HasStarted)
            {
                return;
            }

            // 只处理 API 请求的错误，不处理静态文件的 404
            var path = context.Request.Path.Value ?? "";
            var isApiRequest = path.StartsWith("/api/", StringComparison.OrdinalIgnoreCase);
            
            // Success responses (including 204 No Content, which cannot carry a body) are left alone.
            if (isApiRequest && context.Response.StatusCode >= 400)
            {
                var statusCode = context.Response.StatusCode;
                var msg = "";
                if (statusCode == 401)
                {
                    msg = "Sign in again to continue.";
                }
                else if (statusCode == 404)
                {
                    msg = "Not found.";
                }
                else if (statusCode == 502)
                {
                    msg = "The request could not be completed.";
                }
                else if (statusCode != 200 && statusCode != 400)
                {
                    msg = "The request failed.";
                }
                if (!string.IsNullOrWhiteSpace(msg))
                {
                    await HandleExceptionAsync(context, statusCode, msg);
                }
            }
        }
        private static Task HandleExceptionAsync(HttpContext context, int statusCode, string msg)
        {
            var result = JsonConvert.SerializeObject(new { success = false, Msg = msg, errorMessage = msg, Type = statusCode.ToString() });
            if (!context.Response.HasStarted)
            {
                context.Response.StatusCode = statusCode;
                context.Response.ContentType = "application/json; charset=utf-8";
            }
            return context.Response.WriteAsync(result);
        }
    }
    public static class ErrorHandlingExtensions
    {
        public static IApplicationBuilder UseErrorHandling(this IApplicationBuilder builder)
        {
            return builder.UseMiddleware<ErrorHandlingMiddleware>();
        }
    }
}
