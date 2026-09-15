#!/bin/sh
set -eu
docker build -t remote-play-pixels native/pixels
docker run --rm -v "$PWD:/src" remote-play-pixels --target=wasm32 -O3 -msimd128 -nostdlib native/pixels/pixels.c -Wl,--no-entry -Wl,--export=convert -Wl,--initial-memory=33554432 -Wl,--max-memory=33554432 -o web/vendor/pixels.wasm
