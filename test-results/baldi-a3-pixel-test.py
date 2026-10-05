#!/usr/bin/env python3
import pathlib, subprocess
root = pathlib.Path(__file__).resolve().parents[1]
src = (root / 'source/opengl/gl64bridge.cpp').read_text()
start = src.index('bool bgraToRgba(')
end = src.index('// Bytes a glTexImage2D', start)
header = '''#include <vector>
#include <cstdint>
#include <cstring>
#include <cassert>
#include <cstdio>
using U8 = uint8_t; using U32 = uint32_t; using GLenum = unsigned; using GLint = int;
#define GL_RGBA 0x1908
#define GL_RGB 0x1907
#define GL_UNSIGNED_BYTE 0x1401
'''
tests = r'''
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
'''
cpp = root / 'test-results/baldi-a3-pixel-test.cpp'
exe = root / 'test-results/baldi-a3-pixel-test'
cpp.write_text(header + src[start:end] + tests)
subprocess.run(['g++', '-std=c++17', '-Wall', '-Wextra', '-O2', str(cpp), '-o', str(exe)], check=True)
subprocess.run([str(exe)], check=True)
