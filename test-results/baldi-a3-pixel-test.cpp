#include <vector>
#include <cstdint>
#include <cstring>
#include <cassert>
#include <cstdio>
using U8 = uint8_t; using U32 = uint32_t; using GLenum = unsigned; using GLint = int;
#define GL_RGBA 0x1908
#define GL_RGB 0x1907
#define GL_UNSIGNED_BYTE 0x1401
bool bgraToRgba(GLenum& fmt, GLenum type, std::vector<U8>& pix) {
    const bool isBgra = (fmt == 0x80E1 /*GL_BGRA*/);
    const bool isBgr  = (fmt == 0x80E0 /*GL_BGR*/);
    if (!isBgra && !isBgr) return false;
    // Packed types must be unpacked before swapping channels. Their enum values
    // and bit layouts are NOT interchangeable (0x8367 is 8_8_8_8_REV).
    if (type != GL_UNSIGNED_BYTE) return false;
    {
        size_t stride = isBgra ? 4 : 3;
        size_t texels = pix.size() / stride;
        U8* p = pix.data();
        for (size_t i = 0; i < texels; i++) {
            U8 t = p[i*stride+0]; p[i*stride+0] = p[i*stride+2]; p[i*stride+2] = t;
        }
    }
    fmt = isBgra ? GL_RGBA : GL_RGB;
    return true;
}

// Convert desktop-only packed/legacy layouts to GLES3 storage tuples. Unlike
// the inherited A2 fixup, retain RGB10_A2's native 2_10_10_10_REV representation,
// scale each packed component by its actual bit width, and swap BGRA channels
// AFTER unpacking. Empty pixel vectors still need valid allocation formats.
// Regression vectors: test-results/baldi-a3-pixel-test.py.
void glesTexFormatFixup(GLint& ifmt, GLenum& fmt, GLenum& type, std::vector<U8>& pix) {
    // WebGL2 accepts RGB10_A2 + RGBA + UNSIGNED_INT_2_10_10_10_REV
    // natively. The inherited fixup changed its type to BYTE, making it invalid.
    if (ifmt == 0x8059 && fmt == GL_RGBA && type == 0x8368) return;
    if (ifmt == 0x8059 && fmt == GL_RGBA && type == GL_UNSIGNED_BYTE) {
        std::vector<U8> packed(pix.size());
        for (size_t i = 0; i + 4 <= pix.size(); i += 4) {
            U32 word = ((U32)pix[i] * 1023 + 127) / 255 |
                (((U32)pix[i+1] * 1023 + 127) / 255) << 10 |
                (((U32)pix[i+2] * 1023 + 127) / 255) << 20 |
                (((U32)pix[i+3] * 3 + 127) / 255) << 30;
            memcpy(packed.data() + i, &word, 4);
        }
        pix.swap(packed);
        type = 0x8368;
        return;
    }
    if (type == 0x1403 /*UNSIGNED_SHORT*/ && fmt == 0x1909 /*LUMINANCE*/ && ifmt == 0x8042 /*LUMINANCE16*/) {
        // Keep 16-bit normalized precision in native R16_EXT storage when the
        // browser exposes EXT_texture_norm16; no fallback claim of support.
        fmt = 0x1903; ifmt = 0x822A;
        return;
    }
    // Legacy ALPHA/LUMINANCE storage is absent from GLES3. Expand to RGBA8
    // with the desktop sampling values rather than retaining invalid enums.
    if (type == GL_UNSIGNED_BYTE && (fmt == 0x1906 || fmt == 0x1909 || fmt == 0x190A)) {
        size_t stride = fmt == 0x190A ? 2 : 1;
        std::vector<U8> out(pix.size() / stride * 4);
        for (size_t i = 0; i < pix.size() / stride; ++i) {
            U8 lum = fmt == 0x1906 ? 255 : pix[i * stride];
            U8 alpha = fmt == 0x1906 ? pix[i] : (stride == 2 ? pix[i * stride + 1] : 255);
            out[i*4] = out[i*4+1] = out[i*4+2] = lum;
            out[i*4+3] = alpha;
        }
        pix.swap(out);
        fmt = GL_RGBA;
        ifmt = 0x8058;
        return;
    }
    int bits[4] = {0, 0, 0, 0};
    int shifts[4] = {0, 0, 0, 0};
    size_t stride = 0;
    int components = 4;
    switch (type) {
        case 0x8363: stride=2; components=3; bits[0]=5; bits[1]=6; bits[2]=5;
            shifts[0]=11; shifts[1]=5; break; // 5_6_5
        case 0x8035: stride=4; bits[0]=bits[1]=bits[2]=bits[3]=8;
            shifts[0]=24; shifts[1]=16; shifts[2]=8; break; // 8_8_8_8
        case 0x8367: stride=4; bits[0]=bits[1]=bits[2]=bits[3]=8;
            shifts[1]=8; shifts[2]=16; shifts[3]=24; break; // 8_8_8_8_REV
        case 0x8368: stride=4; bits[0]=bits[1]=bits[2]=10; bits[3]=2;
            shifts[1]=10; shifts[2]=20; shifts[3]=30; break; // 2_10_10_10_REV
        case 0x8036: stride=4; bits[0]=bits[1]=bits[2]=10; bits[3]=2;
            shifts[0]=22; shifts[1]=12; shifts[2]=2; break; // 10_10_10_2
        case 0x8365: stride=2; bits[0]=bits[1]=bits[2]=bits[3]=4;
            shifts[1]=4; shifts[2]=8; shifts[3]=12; break; // 4_4_4_4_REV
        case 0x8366: stride=2; bits[0]=bits[1]=bits[2]=5; bits[3]=1;
            shifts[1]=5; shifts[2]=10; shifts[3]=15; break; // 1_5_5_5_REV
        case 0x8032: stride=1; components=3; bits[0]=3; bits[1]=3; bits[2]=2;
            shifts[0]=5; shifts[1]=2; break; // 3_3_2
        default: return;
    }
    bool rgbStorage = ifmt == 0x8050 /*RGB5*/ || ifmt == 0x8051 /*RGB8*/ ||
                      ifmt == 0x804F /*RGB4*/ || ifmt == 0x2A10 /*R3_G3_B2*/ || ifmt == 0x8C41;
    int outComponents = rgbStorage ? 3 : components;
    std::vector<U8> out(pix.size() / stride * outComponents);
    for (size_t i = 0; i < pix.size() / stride; ++i) {
        U32 word = 0;
        memcpy(&word, pix.data() + i * stride, stride);
        U8 rgba[4] = {0, 0, 0, 255};
        for (int c = 0; c < components; ++c) {
            U32 mask = (1u << bits[c]) - 1;
            rgba[c] = (U8)((((word >> shifts[c]) & mask) * 255 + mask / 2) / mask);
        }
        if (fmt == 0x80E1 || fmt == 0x80E0) std::swap(rgba[0], rgba[2]);
        memcpy(out.data() + i * outComponents, rgba, outComponents);
    }
    pix.swap(out);
    fmt = outComponents == 3 ? GL_RGB : GL_RGBA;
    type = GL_UNSIGNED_BYTE;
    if (rgbStorage && ifmt != 0x8C41) ifmt = 0x8051; // emulate legacy RGB precision
    // BGRA 8_8_8_8_REV -> bytes can also feed RGB10_A2; finish packing after
    // unpack/swizzle, not just when the ORIGINAL input type was BYTE.
    if (ifmt == 0x8059) glesTexFormatFixup(ifmt, fmt, type, pix);
}


int main() {
    auto check = [](GLint internal, GLenum format, GLenum type, std::vector<U8> pixels,
                    GLenum expectedType, const std::vector<U8>& expected) {
        bgraToRgba(format, type, pixels);
        glesTexFormatFixup(internal, format, type, pixels);
        assert(type == expectedType);
        assert(pixels == expected);
    };
    check(0x8058, GL_RGBA, 0x8035, {0x44,0x33,0x22,0x11}, GL_UNSIGNED_BYTE, {0x11,0x22,0x33,0x44});
    check(0x8058, 0x80e1, 0x8367, {0x33,0x22,0x11,0x44}, GL_UNSIGNED_BYTE, {0x11,0x22,0x33,0x44});
    check(0x8056, GL_RGBA, 0x8365, {0x1f,0x84}, GL_UNSIGNED_BYTE, {255,17,68,136});
    check(0x8057, GL_RGBA, 0x8366, {0x1f,0xfc}, GL_UNSIGNED_BYTE, {255,0,255,255});
    check(0x8051, GL_RGBA, 0x8368, {0xff,0x03,0x00,0xc0}, GL_UNSIGNED_BYTE, {255,0,0});
    check(0x8059, GL_RGBA, 0x8368, {}, 0x8368, {});
    check(0x8058, GL_RGBA, 0x8368, {}, GL_UNSIGNED_BYTE, {});
    check(0x8059, GL_RGBA, GL_UNSIGNED_BYTE, {255,0,0,255}, 0x8368, {255,3,0,192});
    check(0x8050, GL_RGB, 0x8363, {0,248}, GL_UNSIGNED_BYTE, {255,0,0});
    check(0x803c, 0x1906, GL_UNSIGNED_BYTE, {127}, GL_UNSIGNED_BYTE, {255,255,255,127});
    check(0x8045, 0x190a, GL_UNSIGNED_BYTE, {64,127}, GL_UNSIGNED_BYTE, {64,64,64,127});
    check(0x8059, 0x80e1, 0x8367, {}, 0x8368, {});
    puts("PASS pixel regression vectors (12)");
}
