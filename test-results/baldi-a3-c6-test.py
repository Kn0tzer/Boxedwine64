#!/usr/bin/env python3
import pathlib, subprocess
root = pathlib.Path(__file__).resolve().parents[1]
src = (root / 'source/opengl/gl64bridge.cpp').read_text()
start = src.index('// Desktop pack layout')
end = src.index('// Read a NUL-terminated C string', start)
header = '''#include <vector>
#include <cstdint>
#include <cstring>
#include <cassert>
#include <cstdio>
#include <map>
using U8 = uint8_t; using U32 = uint32_t; using S32 = int32_t; using GLuint = unsigned;
using GLenum = unsigned; using GLint = int; using GLsizei = int;
#define GL_NONE 0
#define GL_RGBA 0x1908
#define GL_RGB 0x1907
#define GL_UNSIGNED_BYTE 0x1401
#define GL_BYTE 0x1400
#define GL_UNSIGNED_SHORT 0x1403
#define GL_SHORT 0x1402
#define GL_UNSIGNED_INT 0x1405
#define GL_INT 0x1404
#define GL_FLOAT 0x1406
#define GL_TEXTURE_BINDING_2D 0x8069
#define GL_TEXTURE_BINDING_3D 0x806A
#define GL_TEXTURE_BINDING_CUBE_MAP 0x8514
#define GL_TEXTURE_2D 0x0DE1
#define GL_TEXTURE_3D 0x806F
#define GL_TEXTURE_2D_ARRAY 0x8C1A
void glGetIntegerv(GLenum, GLint*) {}
static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL line %d: %s\\n", __LINE__, #cond); failures++; } } while (0)
'''
tests = r'''
int main() {
    // sizedFormatBits spot checks
    { int r=-1,g=-1,b=-1,a=-1,d=-1,s=-1;
      CHECK(sizedFormatBits(0x8058, r,g,b,a,d,s) && r==8 && g==8 && b==8 && a==8 && d==0 && s==0);
      CHECK(sizedFormatBits(0x822F, r,g,b,a,d,s) && r==16 && g==16 && b==0 && a==0);
      CHECK(sizedFormatBits(0x881A, r,g,b,a,d,s) && r==16 && a==16);
      CHECK(sizedFormatBits(0x81A5, r,g,b,a,d,s) && d==16 && r==0);
      CHECK(sizedFormatBits(0x88F0, r,g,b,a,d,s) && d==24 && s==8);
      CHECK(sizedFormatBits(0x8F97, r,g,b,a,d,s) && r==8 && a==8);
      CHECK(!sizedFormatBits(0x1234, r,g,b,a,d,s)); }
    // renderbufferStorageFixup: legacy unsized -> RGBA8, sized untouched
    { GLenum f = 0x8050; CHECK(renderbufferStorageFixup(f) && f == 0x8058);
      f = 0x8042; CHECK(renderbufferStorageFixup(f) && f == 0x8058);
      f = 0x2A10; CHECK(renderbufferStorageFixup(f) && f == 0x8058);
      f = 0x8F96; CHECK(!renderbufferStorageFixup(f) && f == 0x8F96); // SNORM: honest fail
      f = 0x8815; CHECK(!renderbufferStorageFixup(f) && f == 0x8815); // RGB32F: honest fail
      f = 0x8C41; CHECK(!renderbufferStorageFixup(f) && f == 0x8C41); // SRGB8: honest fail
      f = 0x8058; CHECK(!renderbufferStorageFixup(f)); }
    // canonicalFloatTuple: RGBA/BYTE probe of R16F -> RED/FLOAT upconvert
    { GLenum fmt = GL_RGBA, type = GL_UNSIGNED_BYTE; std::vector<U8> px = {255,0,0,255};
      CHECK(canonicalFloatTuple(0x822D, fmt, type, px));
      CHECK(fmt == 0x1903 && type == GL_FLOAT && px.size() == 4);
      float v; memcpy(&v, px.data(), 4); CHECK(v > 0.999f && v < 1.001f); }
    { GLenum fmt = GL_RGBA, type = GL_UNSIGNED_BYTE; std::vector<U8> px = {255,128,0,255};
      CHECK(canonicalFloatTuple(0x822F, fmt, type, px));
      CHECK(fmt == 0x8227 && type == GL_FLOAT && px.size() == 8); }
    { GLenum fmt = GL_RGBA, type = GL_UNSIGNED_BYTE; std::vector<U8> px = {};
      CHECK(canonicalFloatTuple(0x881A, fmt, type, px));
      CHECK(fmt == GL_RGBA && type == GL_FLOAT && px.empty()); } // NULL alloc: tuple only
    { GLenum fmt = GL_RGBA, type = GL_FLOAT; std::vector<U8> px = {1,2,3,4};
      CHECK(!canonicalFloatTuple(0x822D, fmt, type, px)); } // non-BYTE: untouched
    { GLenum fmt = 0x1903, type = GL_UNSIGNED_BYTE; std::vector<U8> px = {9};
      CHECK(!canonicalFloatTuple(0x822D, fmt, type, px)); } // 1-ch source: untouched
    { GLenum fmt = GL_RGBA, type = GL_UNSIGNED_BYTE; std::vector<U8> px = {1,2,3,4};
      CHECK(!canonicalFloatTuple(0x8058, fmt, type, px)); } // non-float ifmt: untouched
    // packedReadStride with explicit bpt
    { CHECK(packedReadStride(4, 0, 4, 4) == 16);
      CHECK(packedReadStride(3, 0, 4, 4) == 12);
      CHECK(packedReadStride(3, 0, 4, 16) == 48);
      CHECK(packedReadStride(5, 8, 4, 2) == 16);
      CHECK(packedReadStride(4, 0, 1, 1) == 4); }
    if (failures) { printf("FAILURES %d\n", failures); return 1; }
    puts("PASS c6 helper vectors (28)");
}
'''
cpp = root / 'test-results/baldi-a3-c6-test.cpp'
exe = root / 'test-results/baldi-a3-c6-test'
cpp.write_text(header + src[start:end] + tests)
subprocess.run(['g++', '-std=c++17', '-Wall', '-Wextra', '-O2', str(cpp), '-o', str(exe)], check=True)
subprocess.run([str(exe)], check=True)
