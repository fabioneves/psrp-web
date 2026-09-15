FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY RemotePlay/RemotePlay.csproj RemotePlay/
COPY RemotePlay.DBTool/RemotePlay.DBTool.csproj RemotePlay.DBTool/
RUN dotnet restore RemotePlay.DBTool/RemotePlay.DBTool.csproj
COPY RemotePlay/ RemotePlay/
COPY RemotePlay.DBTool/ RemotePlay.DBTool/
RUN dotnet publish RemotePlay/RemotePlay.csproj -c Release --no-restore -o /out/app && dotnet publish RemotePlay.DBTool/RemotePlay.DBTool.csproj -c Release --no-restore -o /out/migrate

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS test-base
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
FROM test-base AS test
WORKDIR /src
COPY --from=build /src/ /src/
COPY --from=build /root/.nuget/ /root/.nuget/
COPY tests/backend/ tests/backend/
RUN dotnet run --project tests/backend/BackendTests.csproj -c Release

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/app/ ./
COPY --from=build /out/migrate/ /migrate/
COPY web/ ./wwwroot/
COPY scripts/entrypoint.sh /entrypoint.sh
RUN mkdir -p /data && chown app:app /data && chmod +x /entrypoint.sh
USER app
ENV ASPNETCORE_URLS=http://0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
