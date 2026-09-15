#include <wasm_simd128.h>
typedef unsigned char u8;
void convert(const u8 *y, const u8 *cr, const u8 *cb, unsigned int *rgba, int width, int height, int stride) {
    v128_t zero = wasm_i32x4_splat(0), max = wasm_i32x4_splat(255), alpha = wasm_i32x4_splat(0xff000000u);
    for (int row = 0; row < height; row += 2) {
        for (int col = 0; col < width; col += 2) {
            int c = (row / 2) * (stride / 2) + col / 2;
            int r = cr[c] + ((cr[c] * 103) >> 8) - 179;
            int g = ((cb[c] * 88) >> 8) - 44 + ((cr[c] * 183) >> 8) - 91;
            int b = cb[c] + ((cb[c] * 198) >> 8) - 227;
            const u8 *p = y + row * stride + col;
            v128_t values = wasm_i32x4_make(p[0], p[1], p[stride], p[stride + 1]);
            v128_t red = wasm_i32x4_min(max, wasm_i32x4_max(zero, wasm_i32x4_add(values, wasm_i32x4_splat(r))));
            v128_t green = wasm_i32x4_min(max, wasm_i32x4_max(zero, wasm_i32x4_sub(values, wasm_i32x4_splat(g))));
            v128_t blue = wasm_i32x4_min(max, wasm_i32x4_max(zero, wasm_i32x4_add(values, wasm_i32x4_splat(b))));
            v128_t pixels = wasm_v128_or(alpha, wasm_v128_or(red, wasm_v128_or(wasm_i32x4_shl(green, 8), wasm_i32x4_shl(blue, 16))));
            unsigned int *out = rgba + row * width + col;
            out[0] = wasm_i32x4_extract_lane(pixels, 0); out[1] = wasm_i32x4_extract_lane(pixels, 1);
            out[width] = wasm_i32x4_extract_lane(pixels, 2); out[width + 1] = wasm_i32x4_extract_lane(pixels, 3);
        }
    }
}
