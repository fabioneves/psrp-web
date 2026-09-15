#!/bin/sh
set -eu
umask 077
if [ -z "${JWT__Secret:-}" ]; then
    if [ ! -s /data/jwt-secret ]; then
        head -c 48 /dev/urandom | base64 > /data/jwt-secret
    fi
    JWT__Secret=$(cat /data/jwt-secret)
    export JWT__Secret
fi
dotnet /migrate/RemotePlay.DBTool.dll
exec dotnet /app/RemotePlay.dll
