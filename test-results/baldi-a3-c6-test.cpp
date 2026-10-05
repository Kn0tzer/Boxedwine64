#include <vector>
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
#define CHECK(cond) do { if (!(cond)) { printf("FAIL line %d: %s\n", __LINE__, #cond); failures++; } } while (0)
// Desktop pack layout: alignment applies to rows, skips are relative to the
// caller's destination, and the last row has no trailing padding requirement.
size_t packedReadStride(GLsizei width, GLint rowLength, GLint alignment, size_t bpt) {
    if (alignment < 1) alignment = 1;
    size_t bytes = (size_t)(rowLength > 0 ? rowLength : width) * bpt;
    return (bytes + (size_t)alignment - 1) & ~((size_t)alignment - 1);
}
GLuint boundTexture(GLenum target) {
    GLint id = 0;
    GLenum binding = GL_TEXTURE_BINDING_2D;
    // Resolve the binding query matching the guest target. Desktop-only
    // targets (rectangle/1D) are backed by 2D storage; 3D and 2D-array have
    // their own bindings — answering with the 2D binding made every 3D
    // metadata lookup miss (and every 3D readback fail INVALID_OPERATION).
    if (target >= 0x8515 && target <= 0x851A) binding = GL_TEXTURE_BINDING_CUBE_MAP;
    else if (target == 0x806F /*GL_TEXTURE_3D*/) binding = GL_TEXTURE_BINDING_3D;
    else if (target == 0x8C1A /*GL_TEXTURE_2D_ARRAY*/) binding = 0x8C1D /*GL_TEXTURE_BINDING_2D_ARRAY*/;
    glGetIntegerv(binding, &id);
    return (GLuint)id;
}

// Component bit widths of a sized internal format, for texture level queries
// (GL_TEXTURE_RED_SIZE etc.). Returns false for unknown/compressed formats.
bool sizedFormatBits(GLint ifmt, int& r, int& g, int& b, int& a, int& d, int& s) {
    r = g = b = a = d = s = 0;
    switch (ifmt) {
        case 0x8229: r = 8; return true;                                  // R8
        case 0x822A: r = 16; return true;                                 // R16
        case 0x822B: r = g = 8; return true;                              // RG8
        case 0x822C: r = g = 8; return true;                              // RG8I/UI-ish (bits only)
        case 0x822D: r = 16; return true;                                 // R16F
        case 0x822E: r = 32; return true;                                 // R32F
        case 0x822F: r = g = 16; return true;                             // RG16F
        case 0x8230: r = g = 32; return true;                             // RG32F
        case 0x8058: r = g = b = a = 8; return true;                      // RGBA8
        case 0x8051: r = g = b = 8; return true;                          // RGB8
        case 0x8D62: r = 5; g = 6; b = 5; return true;                     // RGB565
        case 0x8056: r = g = b = a = 4; return true;                       // RGBA4
        case 0x8057: r = g = b = 5; a = 1; return true;                    // RGB5_A1
        case 0x8059: r = g = b = 10; a = 2; return true;                  // RGB10_A2
        case 0x881A: r = g = b = a = 16; return true;                      // RGBA16F
        case 0x8814: r = g = b = a = 32; return true;                      // RGBA32F
        case 0x881B: r = g = b = 16; return true;                         // RGB16F
        case 0x8815: r = g = b = 32; return true;                          // RGB32F
        case 0x8C3A: r = g = 11; b = 10; return true;                      // R11F_G11F_B10F
        case 0x8C3B: r = g = b = 9; return true;                           // RGB9_E5 (shared exp; bits approx)
        case 0x81A5: d = 16; return true;                                  // DEPTH_COMPONENT16
        case 0x81A6: d = 24; return true;                                  // DEPTH_COMPONENT24
        case 0x81A7: d = 32; return true;                                  // DEPTH_COMPONENT32
        case 0x8CAC: d = 32; return true;                                  // DEPTH_COMPONENT32F
        case 0x88F0: d = 24; s = 8; return true;                           // DEPTH24_STENCIL8
        case 0x8CAD: d = 32; s = 8; return true;                           // DEPTH32F_STENCIL8
        case 0x8D48: s = 8; return true;                                   // STENCIL_INDEX8
        default: break;
    }
    // SNORM blocks: same widths as their UNORM siblings.
    if ((ifmt >= 0x8F94 && ifmt <= 0x8F9B)) {
        switch (ifmt) {
            case 0x8F94: case 0x8F98: r = (ifmt == 0x8F94) ? 8 : 16; return true;
            case 0x8F95: case 0x8F99: r = g = (ifmt == 0x8F95) ? 8 : 16; return true;
            case 0x8F96: r = g = b = 8; return true;
            case 0x8F97: r = g = b = a = 8; return true;
            case 0x8F9A: r = g = b = 16; return true;
            case 0x8F9B: r = g = b = a = 16; return true;
            default: break;
        }
    }
    return false;
}

// Sized float internal formats need a float upload tuple. Wine sometimes
// issues them with RGBA/UNSIGNED_BYTE pixels (capability probes); WebGL2
// rejects that with INVALID_OPERATION, leaving no level 0 and an
// INCOMPLETE_ATTACHMENT FBO. Upconvert bytes to floats in software and set
// the canonical (format, FLOAT) tuple. Returns true when rewritten.
bool canonicalFloatTuple(GLint ifmt, GLenum& fmt, GLenum& type, std::vector<U8>& pix) {
    if (type != GL_UNSIGNED_BYTE) return false;
    // Only 3/4-channel byte sources (Wine's RGBA probe layout); 1/2-channel
    // sources already match their R/RG internal formats.
    if (fmt != GL_RGBA && fmt != GL_RGB && fmt != 0x80E1 && fmt != 0x80E0) return false;
    GLenum want = GL_NONE;
    int comps = 0;
    switch (ifmt) {
        case 0x822D: case 0x822E: want = 0x1903; comps = 1; break;         // R16F/R32F -> RED
        case 0x822F: case 0x8230: want = 0x8227; comps = 2; break;          // RG16F/RG32F -> RG
        case 0x881A: case 0x8814: want = GL_RGBA; comps = 4; break;        // RGBA16F/32F
        case 0x881B: case 0x8815: want = GL_RGB; comps = 3; break;         // RGB16F/32F
        case 0x8C3A: case 0x8C3B: want = GL_RGB; comps = 3; break;         // R11F_G11F_B10F/RGB9_E5
        default: return false;
    }
    // Source pixels are RGBA or RGB bytes (Wine's probe layout); pick the
    // first `comps` channels of each texel.
    int srcComps = (fmt == GL_RGB || fmt == 0x80E0) ? 3 : 4;
    size_t texels = pix.size() / (size_t)srcComps;
    std::vector<U8> out(texels * comps * 4);
    float* dst = (float*)out.data();
    for (size_t i = 0; i < texels; i++)
        for (int c = 0; c < comps; c++)
            dst[i * comps + c] = pix[i * srcComps + c] / 255.0f;
    pix.swap(out);
    fmt = want;
    type = GL_FLOAT;
    return true;
}

// Legacy unsized internal formats have no WebGL2 renderbuffer storage.
// Desktop GL defines their renderability via the base format; back them with
// RGBA8 (the standard emulation). Sized-but-not-renderable formats (float,
// SNORM, sRGB-plain, packed-float) are left to fail honestly — mapping those
// would lie about device capabilities.
bool renderbufferStorageFixup(GLenum& ifmt) {
    switch (ifmt) {
        case 0x2A10 /*R3_G3_B2*/:
        case 0x803C /*ALPHA8*/: case 0x803B /*ALPHA4*/:
        case 0x8040 /*LUMINANCE8*/: case 0x8042 /*LUMINANCE16*/:
        case 0x8043 /*LUMINANCE4_ALPHA4*/: case 0x8045 /*LUMINANCE8_ALPHA8*/:
        case 0x804F /*RGB4*/: case 0x8050 /*RGB5*/:
            ifmt = 0x8058 /*RGBA8*/;
            return true;
        default:
            return false;
    }
}


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
