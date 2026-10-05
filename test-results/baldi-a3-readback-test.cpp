#include <cstddef>
#include <cassert>
#include <cstdio>
using GLenum=unsigned; using GLsizei=int; using GLint=int;
#define GL_NO_ERROR 0
GLenum g_allocationError = GL_NO_ERROR;
void recordBridgeError(GLenum error) {
    if (error && !g_allocationError) g_allocationError = error;
}
// Desktop pack layout: alignment applies to rows, skips are relative to the
// caller's destination, and the last row has no trailing padding requirement.
size_t packedReadStride(GLsizei width, GLint rowLength, GLint alignment) {
    size_t bytes = (size_t)(rowLength > 0 ? rowLength : width) * 4;
    return (bytes + alignment - 1) & ~(size_t)(alignment - 1);
}

int main() {
    assert(packedReadStride(3,0,4)==12);
    assert(packedReadStride(3,0,8)==16);
    assert(packedReadStride(3,5,8)==24);
    assert(packedReadStride(1,0,1)==4);
    recordBridgeError(0); assert(g_allocationError==0);
    recordBridgeError(0x500); recordBridgeError(0x502);
    assert(g_allocationError==0x500);
    g_allocationError=0; recordBridgeError(0x502);
    assert(g_allocationError==0x502);
    puts("PASS readback pack layout and first-error regression vectors (7)");
}
