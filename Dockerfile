FROM ubuntu:24.04 AS psn-build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git build-essential cmake pkg-config python3 python3-protobuf protobuf-compiler libssl-dev libjson-c-dev libminiupnpc-dev libevent-dev && rm -rf /var/lib/apt/lists/*
ARG CHIAKI_REVISION=a9a2805884cfa83865fdfcc09ca3ddfcd628aa42
RUN git init /chiaki && cd /chiaki && git remote add origin https://github.com/streetpea/chiaki-ng.git && git fetch --depth 1 origin "$CHIAKI_REVISION" && git checkout FETCH_HEAD && git submodule update --init --depth 1 third-party/curl third-party/nanopb third-party/gf-complete third-party/jerasure
WORKDIR /src
COPY native/psn/CMakeLists.txt native/psn/main.c ./
COPY Dockerfile /src/Dockerfile
RUN tar --exclude=.git -czf /native-psn-source.tar.gz /chiaki /src 2>/dev/null
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DCHIAKI_SOURCE_DIR=/chiaki && cmake --build build --target remote-play-psn -j 4

# libdatachannel carries the WebRTC video transport. Data channels only: no media, and ASP.NET Core does the signaling.
FROM psn-build AS rtc-build
ARG LIBDATACHANNEL_TAG=v0.24.5
RUN git clone --depth 1 --branch "$LIBDATACHANNEL_TAG" --recurse-submodules --shallow-submodules https://github.com/paullouisageneau/libdatachannel.git /ldc
RUN cmake -S /ldc -B /ldc/build -DCMAKE_BUILD_TYPE=Release -DNO_MEDIA=ON -DNO_WEBSOCKET=ON -DNO_EXAMPLES=ON -DNO_TESTS=ON && cmake --build /ldc/build -j 4 && mkdir /out && cp -L /ldc/build/libdatachannel.so /out/ && strip /out/libdatachannel.so

FROM node:24-bookworm-slim AS web
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
WORKDIR /src
COPY scripts/build-web.mjs scripts/build-web.mjs
COPY web/ web/
RUN node scripts/build-web.mjs web /out

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
# The loader finds a library in /usr/lib by file name; ldconfig would index it only under its versioned soname.
COPY --from=rtc-build /out/libdatachannel.so /usr/lib/
WORKDIR /src
COPY --from=build /src/ /src/
COPY --from=build /root/.nuget/ /root/.nuget/
COPY tests/backend/ tests/backend/
RUN dotnet run --project tests/backend/BackendTests.csproj -c Release

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl libjson-c5 libminiupnpc17 libevent-2.1-7t64 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/app/ ./
COPY --from=build /out/migrate/ /migrate/
COPY --from=web /out/ ./wwwroot/
COPY --from=psn-build /src/build/remote-play-psn ./remote-play-psn
COPY --from=psn-build /chiaki/COPYING /usr/share/doc/remote-play-psn/COPYING
COPY --from=psn-build /chiaki/LICENSES/ /usr/share/doc/remote-play-psn/LICENSES/
COPY --from=psn-build /native-psn-source.tar.gz ./wwwroot/native-psn-source.tar.gz
COPY --from=rtc-build /out/libdatachannel.so /usr/lib/
COPY --from=rtc-build /ldc/LICENSE /usr/share/doc/libdatachannel/LICENSE
COPY scripts/entrypoint.sh /entrypoint.sh
RUN mkdir -p /data && chown app:app /data && chmod +x /entrypoint.sh
USER app
ENV ASPNETCORE_URLS=http://0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
