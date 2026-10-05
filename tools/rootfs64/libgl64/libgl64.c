/*
 *  Copyright (C) 2012-2025  The BoxedWine Team
 *
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 */

// Guest libGL.so.1 for the 64-bit Boxedwine wine path. wine's winex11.drv
// dlopen("libGL.so.1") and resolves glXGetProcAddressARB + the core GLX entry
// points; opengl32 then resolves every gl* function through glXGetProcAddressARB.
// Each wrapper here packs its arguments into a GL64Args block and traps to the
// host (Boxedwine64's kernel) via a private syscall (see gl64bridge_abi.h /
// source/opengl/gl64bridge.cpp), where the call is replayed on a real macOS GL
// context. This is the 64-bit analogue of the 32-bit int-0x99 GL shim.
//
// Self-contained: no GL/GLX headers required. We declare just enough typedefs to
// export the right symbol names with C linkage.

// Freestanding: no libc headers (the build cross-compiles to x86_64-linux from
// macOS, which has no Linux libc headers/objects). We define the few fixed-width
// types and string/mem helpers we need locally so the .so has no libc DT_NEEDED.
typedef unsigned char       uint8_t;
typedef unsigned int        uint32_t;
typedef unsigned long long  uint64_t;
typedef unsigned long       uintptr_t;

static void* gl_memcpy(void* d, const void* s, unsigned long n) {
    unsigned char* dd = (unsigned char*)d; const unsigned char* ss = (const unsigned char*)s;
    while (n--) *dd++ = *ss++; return d;
}
static void* gl_memset(void* d, int v, unsigned long n) {
    unsigned char* dd = (unsigned char*)d; while (n--) *dd++ = (unsigned char)v; return d;
}
static int gl_strcmp(const char* a, const char* b) {
    while (*a && (*a == *b)) { a++; b++; } return (int)((unsigned char)*a) - (int)((unsigned char)*b);
}
#define memcpy gl_memcpy
#define memset gl_memset
#define strcmp gl_strcmp

// ---- ABI shared with the host (copy kept in sync with source/opengl) -------
#define GL64_SYSCALL_NR  ((uint64_t)0x474C0000ULL)
#define GL64_MAX_ARGS 16
typedef struct GL64Args { uint64_t a[GL64_MAX_ARGS]; } GL64Args;

enum {
    GL64_fn_glXQueryVersion = 1,
    GL64_fn_glXQueryExtension,
    GL64_fn_glXQueryExtensionsString,
    GL64_fn_glXChooseVisual,
    GL64_fn_glXCreateContext,
    GL64_fn_glXCreateContextAttribsARB,
    GL64_fn_glXChooseFBConfig,
    GL64_fn_glXGetFBConfigs,
    GL64_fn_glXGetFBConfigAttrib,
    GL64_fn_glXGetVisualFromFBConfig,
    GL64_fn_glXGetConfig,
    GL64_fn_glXMakeCurrent,
    GL64_fn_glXMakeContextCurrent,
    GL64_fn_glXSwapBuffers,
    GL64_fn_glXDestroyContext,
    GL64_fn_glXIsDirect,
    GL64_fn_glXGetCurrentContext,
    GL64_fn_glXGetCurrentDrawable,
    GL64_fn_glXQueryServerString,
    GL64_fn_glXGetClientString,
    GL64_fn_glXWaitGL,
    GL64_fn_glXWaitX,
    GL64_fn_glXSwapIntervalEXT,

    GL64_fn_glClearColor = 200,
    GL64_fn_glClear,
    GL64_fn_glClearDepth,
    GL64_fn_glViewport,
    GL64_fn_glEnable,
    GL64_fn_glDisable,
    GL64_fn_glShadeModel,
    GL64_fn_glDepthFunc,
    GL64_fn_glCullFace,
    GL64_fn_glFrontFace,
    GL64_fn_glHint,
    GL64_fn_glFlush,
    GL64_fn_glFinish,
    GL64_fn_glGetError,
    GL64_fn_glGetString,
    GL64_fn_glGetIntegerv,
    GL64_fn_glGetFloatv,
    GL64_fn_glColor3f,
    GL64_fn_glColor4f,

    GL64_fn_glMatrixMode = 260,
    GL64_fn_glLoadIdentity,
    GL64_fn_glPushMatrix,
    GL64_fn_glPopMatrix,
    GL64_fn_glFrustum,
    GL64_fn_glOrtho,
    GL64_fn_glTranslatef,
    GL64_fn_glRotatef,
    GL64_fn_glScalef,
    GL64_fn_glMultMatrixf,

    GL64_fn_glLightfv = 290,
    GL64_fn_glLightf,
    GL64_fn_glMaterialfv,
    GL64_fn_glMaterialf,
    GL64_fn_glColorMaterial,
    GL64_fn_glNormal3f,

    GL64_fn_glBegin = 320,
    GL64_fn_glEnd,
    GL64_fn_glVertex2f,
    GL64_fn_glVertex3f,

    // === programmable pipeline (must match source/opengl/gl64bridge_abi.h) ===
    GL64_fn_traceProc = 400,

    GL64_fn_glCreateShader = 410,
    GL64_fn_glShaderSource,
    GL64_fn_glCompileShader,
    GL64_fn_glGetShaderiv,
    GL64_fn_glGetShaderInfoLog,
    GL64_fn_glDeleteShader,
    GL64_fn_glCreateProgram,
    GL64_fn_glAttachShader,
    GL64_fn_glDetachShader,
    GL64_fn_glBindAttribLocation,
    GL64_fn_glLinkProgram,
    GL64_fn_glGetProgramiv,
    GL64_fn_glGetProgramInfoLog,
    GL64_fn_glUseProgram,
    GL64_fn_glDeleteProgram,
    GL64_fn_glGetUniformLocation,
    GL64_fn_glGetAttribLocation,
    GL64_fn_glValidateProgram,

    GL64_fn_glUniform1i = 440,
    GL64_fn_glUniform1f,
    GL64_fn_glUniform2f,
    GL64_fn_glUniform3f,
    GL64_fn_glUniform4f,
    GL64_fn_glUniform1fv,
    GL64_fn_glUniform2fv,
    GL64_fn_glUniform3fv,
    GL64_fn_glUniform4fv,
    GL64_fn_glUniform1iv,
    GL64_fn_glUniformMatrix2fv,
    GL64_fn_glUniformMatrix3fv,
    GL64_fn_glUniformMatrix4fv,

    GL64_fn_glGenBuffers = 470,
    GL64_fn_glBindBuffer,
    GL64_fn_glBufferData,
    GL64_fn_glBufferSubData,
    GL64_fn_glDeleteBuffers,
    GL64_fn_glMapBufferRange,

    GL64_fn_glEnableVertexAttribArray = 490,
    GL64_fn_glDisableVertexAttribArray,
    GL64_fn_glVertexAttribPointer,
    GL64_fn_glGenVertexArrays,
    GL64_fn_glBindVertexArray,
    GL64_fn_glDeleteVertexArrays,
    GL64_fn_glVertexAttrib4f,

    GL64_fn_glDrawArrays = 510,
    GL64_fn_glDrawElements,
    GL64_fn_glDrawRangeElements,

    GL64_fn_glBlendFunc = 530,
    GL64_fn_glBlendFuncSeparate,
    GL64_fn_glBlendEquation,
    GL64_fn_glBlendEquationSeparate,
    GL64_fn_glBlendColor,
    GL64_fn_glColorMask,
    GL64_fn_glDepthMask,
    GL64_fn_glStencilFunc,
    GL64_fn_glStencilOp,
    GL64_fn_glStencilMask,
    GL64_fn_glStencilFuncSeparate,
    GL64_fn_glStencilOpSeparate,
    GL64_fn_glStencilMaskSeparate,
    GL64_fn_glScissor,
    GL64_fn_glPolygonOffset,
    GL64_fn_glPolygonMode,
    GL64_fn_glDepthRange,
    GL64_fn_glLineWidth,
    GL64_fn_glPixelStorei,
    GL64_fn_glSampleCoverage,

    GL64_fn_glActiveTexture = 560,
    GL64_fn_glGenTextures,
    GL64_fn_glBindTexture,
    GL64_fn_glDeleteTextures,
    GL64_fn_glTexParameteri,
    GL64_fn_glTexParameterf,
    GL64_fn_glTexImage2D,
    GL64_fn_glTexSubImage2D,
    GL64_fn_glGenerateMipmap,
    GL64_fn_glCompressedTexImage2D,

    GL64_fn_glGetStringi = 590,
    GL64_fn_glGetShaderSource,

    // ARB_sync (must match source/opengl/gl64bridge_abi.h)
    GL64_fn_glFenceSync = 600,
    GL64_fn_glClientWaitSync,
    GL64_fn_glWaitSync,
    GL64_fn_glDeleteSync,
    GL64_fn_glIsSync,
    GL64_fn_glGetSynciv,

    // occlusion / timer queries
    GL64_fn_glGenQueries = 610,
    GL64_fn_glDeleteQueries,
    GL64_fn_glIsQuery,
    GL64_fn_glBeginQuery,
    GL64_fn_glEndQuery,
    GL64_fn_glGetQueryiv,
    GL64_fn_glGetQueryObjectiv,
    GL64_fn_glGetQueryObjectuiv,
    GL64_fn_glGetQueryObjectui64v,
    GL64_fn_glQueryCounter,

    // version mode (must match source/opengl/gl64bridge_abi.h)
    GL64_fn_glVersionMode = 620,

    // === A2: the GL 3.x surface wined3d expects but had no wrappers for ===
    // (must match source/opengl/gl64bridge_abi.h exactly)
    GL64_fn_glGenFramebuffers = 630,
    GL64_fn_glDeleteFramebuffers,
    GL64_fn_glBindFramebuffer,
    GL64_fn_glIsFramebuffer,
    GL64_fn_glFramebufferTexture1D,
    GL64_fn_glFramebufferTexture2D,
    GL64_fn_glFramebufferTexture3D,
    GL64_fn_glFramebufferTexture,
    GL64_fn_glFramebufferTextureLayer,
    GL64_fn_glFramebufferRenderbuffer,
    GL64_fn_glCheckFramebufferStatus,
    GL64_fn_glBlitFramebuffer,
    GL64_fn_glGenRenderbuffers,
    GL64_fn_glDeleteRenderbuffers,
    GL64_fn_glBindRenderbuffer,
    GL64_fn_glRenderbufferStorage,
    GL64_fn_glRenderbufferStorageMultisample,
    GL64_fn_glIsRenderbuffer,
    GL64_fn_glGetRenderbufferParameteriv,
    GL64_fn_glGetFramebufferAttachmentParameteriv,
    GL64_fn_glDrawBuffers,
    GL64_fn_glReadBuffer,

    GL64_fn_glGenSamplers = 660,
    GL64_fn_glDeleteSamplers,
    GL64_fn_glBindSampler,
    GL64_fn_glIsSampler,
    GL64_fn_glSamplerParameteri,
    GL64_fn_glSamplerParameterf,
    GL64_fn_glSamplerParameteriv,
    GL64_fn_glSamplerParameterfv,
    GL64_fn_glSamplerParameterIiv,
    GL64_fn_glSamplerParameterIuiv,
    GL64_fn_glGetSamplerParameteriv,
    GL64_fn_glGetSamplerParameterfv,
    GL64_fn_glGetSamplerParameterIiv,
    GL64_fn_glGetSamplerParameterIuiv,

    GL64_fn_glTexImage3D = 690,
    GL64_fn_glTexSubImage3D,
    GL64_fn_glCompressedTexImage3D,
    GL64_fn_glCompressedTexSubImage3D,
    GL64_fn_glTexImage2DMultisample,
    GL64_fn_glTexImage3DMultisample,

    GL64_fn_glBindFragDataLocation = 700,
    GL64_fn_glGetFragDataIndex,
    GL64_fn_glBindBufferRange,
    GL64_fn_glBindBufferBase,
    GL64_fn_glGetUniformBlockIndex,
    GL64_fn_glUniformBlockBinding,
    GL64_fn_glGetActiveUniformBlockiv,
    GL64_fn_glGetActiveUniformBlockName,
    GL64_fn_glBufferStorage,
    GL64_fn_glCopyBufferSubData,
    GL64_fn_glGetBufferSubData,
    GL64_fn_glGetBufferParameteriv,

    GL64_fn_glUniform2i = 730,
    GL64_fn_glUniform3i,
    GL64_fn_glUniform4i,
    GL64_fn_glUniform2iv,
    GL64_fn_glUniform3iv,
    GL64_fn_glUniform4iv,
    GL64_fn_glGetUniformfv,
    GL64_fn_glGetUniformiv,
    GL64_fn_glGetActiveUniform,
    GL64_fn_glGetAttachedShaders,
    GL64_fn_glGetShaderSourceImpl,
    GL64_fn_glGetTexParameteriv,
    GL64_fn_glGetTexLevelParameteriv,
    GL64_fn_glGetTextureParameteriv,
    GL64_fn_glGetTextureLevelParameteriv,
    GL64_fn_glGetCompressedTexImage,
    GL64_fn_glCompressedTexSubImage2D,

    GL64_fn_glEnablei = 760,
    GL64_fn_glDisablei,
    GL64_fn_glIsEnabledi,
    GL64_fn_glBlendEquationi,
    GL64_fn_glBlendEquationSeparatei,
    GL64_fn_glBlendFunci,
    GL64_fn_glBlendFuncSeparatei,
    GL64_fn_glColorMaski,
    GL64_fn_glMinSampleShading,

    GL64_fn_glVertexAttribDivisor = 780,
    GL64_fn_glDrawArraysInstanced,
    GL64_fn_glDrawElementsInstanced,
    GL64_fn_glDrawArraysInstancedBaseInstance,
    GL64_fn_glDrawElementsInstancedBaseVertexBaseInstance,
    GL64_fn_glDrawElementsBaseVertex,
    GL64_fn_glDrawRangeElementsBaseVertex,

    GL64_fn_glDebugMessageCallback = 800,
    GL64_fn_glDebugMessageControl,
    GL64_fn_glDebugMessageInsert,
    GL64_fn_glGetDebugMessageLog,
    GL64_fn_glBeginTransformFeedback,
    GL64_fn_glEndTransformFeedback,
    GL64_fn_glTransformFeedbackVaryings,
    GL64_fn_glPointParameteri,
    GL64_fn_glPointParameteriv,
    GL64_fn_glPointParameterf,
    GL64_fn_glPointParameterfv,
    GL64_fn_glTexBuffer,
    GL64_fn_glTexBufferRange,
    GL64_fn_glTexBufferARB,
    GL64_fn_glTexBufferRangeARB,
    GL64_fn_glTextureBarrierNV,
    GL64_fn_glFinalCombinerInputNV,
    GL64_fn_glVertexAttrib1f,
    GL64_fn_glVertexAttrib2f,
    GL64_fn_glVertexAttrib3f,
    GL64_fn_glVertexAttrib1fv,
    GL64_fn_glVertexAttrib2fv,
    GL64_fn_glVertexAttrib3fv,
    GL64_fn_glVertexAttrib4fv,
    GL64_fn_glVertexAttrib1d, GL64_fn_glVertexAttrib2d,
    GL64_fn_glVertexAttrib3d, GL64_fn_glVertexAttrib4d,
    GL64_fn_glVertexAttrib1dv, GL64_fn_glVertexAttrib2dv,
    GL64_fn_glVertexAttrib3dv, GL64_fn_glVertexAttrib4dv,
    GL64_fn_glVertexAttribI4i,
    GL64_fn_glVertexAttribI4ui,
    GL64_fn_glVertexAttribI4iv,
    GL64_fn_glVertexAttribI4uiv,

    // === A2 cycle 2: appended only (must match source/opengl/gl64bridge_abi.h) ===
    // glPolygonOffsetClamp is the third of the three conditions
    // feature_level_from_caps() needs before it returns ANY feature level >= 10_0
    // (the others are GL 3.2 and GL_ARB_sampler_objects).
    GL64_fn_glPolygonOffsetClamp = 840,
    GL64_fn_glDrawElementsInstancedBaseVertex,
    GL64_fn_glMultiDrawElementsBaseVertex,
    GL64_fn_glTextureBarrier,
    GL64_fn_glReadPixels = 850,
    GL64_fn_glGetTexImage = 851,
    GL64_fn_glTexStorage2D = 852,
    GL64_fn_glTexStorage3D = 853,
    GL64_fn_glTexStorage1D = 854,
    GL64_fn_glTexStorage2DMultisample = 855,
    GL64_fn_glTexStorage3DMultisample = 856,
    GL64_fn_glGetMultisamplefv = 857
};

// ---- the trap ---------------------------------------------------------------
static inline uint64_t gl64_trap(uint64_t fnId, GL64Args* args) {
    uint64_t ret;
    register uint64_t rdi __asm__("rdi") = fnId;
    register uint64_t rsi __asm__("rsi") = (uint64_t)(uintptr_t)args;
    __asm__ __volatile__(
        "syscall"
        : "=a"(ret)
        : "a"(GL64_SYSCALL_NR), "r"(rdi), "r"(rsi)
        : "rcx", "r11", "memory");
    return ret;
}

// Load-time witness: fire a gl64 trap with fnId=0 the moment winex11/opengl32
// dlopens this libGL. The host bridge logs it under BW64_GLTRACE ("gl64: FIRST
// trap fnId=0"). If that line never prints, the guest never loaded THIS libGL —
// the GL-disable / ChoosePixelFormat=0 failure is in the dlopen, not downstream.
__attribute__((constructor))
static void gl64_loaded_witness(void) {
    gl64_trap(0 /* sentinel: libGL loaded */, 0);
}

// Bit-cast helpers: floats/doubles travel as their raw bits in u64 slots.
static inline uint64_t F2U(float f)  { uint32_t u; memcpy(&u, &f, 4); return (uint64_t)u; }
static inline uint64_t D2U(double d) { uint64_t u; memcpy(&u, &d, 8); return u; }

#define API __attribute__((visibility("default")))

// wine's winex11 calls XFree()/free() on the XVisualInfo* and GLXFBConfig* arrays
// returned by glXChooseVisual / glX*FBConfig* (it expects real Xlib-allocated,
// freeable memory). Returning a static/.bss pointer makes that free() abort with
// "free(): invalid pointer". This .so is freestanding (no libc linked) but is
// dlopen'd into a process that HAS glibc, so the dynamic linker resolves malloc
// from the guest libc at load time. Declare it; never free here (wine owns it).
extern void* malloc(unsigned long size);

// ---- GL minimal typedefs (match the platform C ABI) -------------------------
typedef unsigned int   GLenum;
typedef unsigned int   GLbitfield;
typedef int            GLint;
typedef int            GLsizei;
typedef unsigned char  GLboolean;
typedef unsigned char  GLubyte;
typedef float          GLfloat;
typedef float          GLclampf;
typedef double         GLdouble;
typedef double         GLclampd;
typedef void           GLvoid;

typedef void* GLXContext;
typedef void* GLXFBConfig;
typedef unsigned long  XID;
typedef XID            GLXDrawable;
typedef struct _XDisplay Display;
typedef struct { void* visual; XID visualid; int screen; int depth; int c_class;
                 unsigned long red_mask, green_mask, blue_mask;
                 int colormap_size; int bits_per_rgb; } XVisualInfo;

// ===========================================================================
// GLX entry points
// ===========================================================================
API int glXQueryVersion(Display* dpy, int* major, int* minor) {
    GL64Args a = {{0}}; a.a[0]=(uint64_t)(uintptr_t)major; a.a[1]=(uint64_t)(uintptr_t)minor;
    return (int)gl64_trap(GL64_fn_glXQueryVersion, &a);
}
API GLboolean glXQueryExtension(Display* dpy, int* errorBase, int* eventBase) {
    GL64Args a = {{0}}; a.a[0]=(uint64_t)(uintptr_t)errorBase; a.a[1]=(uint64_t)(uintptr_t)eventBase;
    return (GLboolean)gl64_trap(GL64_fn_glXQueryExtension, &a);
}
API const char* glXQueryExtensionsString(Display* dpy, int screen) {
    // Advertise the extensions winex11 cares about for context creation. Returned
    // from a static buffer in the guest so winex11 can strstr() it directly.
    static const char* s = "GLX_ARB_create_context GLX_ARB_create_context_profile "
                           "GLX_EXT_create_context_es2_profile GLX_ARB_get_proc_address";
    (void)gl64_trap(GL64_fn_glXQueryExtensionsString, 0);
    return s;
}
API const char* glXQueryServerString(Display* dpy, int screen, int name) {
    static const char* vendor = "Boxedwine64";
    static const char* version = "1.4";
    static const char* exts = "GLX_ARB_create_context GLX_ARB_create_context_profile";
    if (name == 1) return vendor;      // GLX_VENDOR
    if (name == 2) return version;     // GLX_VERSION
    return exts;                       // GLX_EXTENSIONS
}
API const char* glXGetClientString(Display* dpy, int name) {
    return glXQueryServerString(dpy, 0, name);
}
API XVisualInfo* glXChooseVisual(Display* dpy, int screen, int* attribList) {
    GL64Args a = {{0}}; a.a[0]=(uint64_t)(uintptr_t)attribList;
    (void)gl64_trap(GL64_fn_glXChooseVisual, &a);
    // Heap-allocate: wine XFree()s this. (See the malloc note above.)
    XVisualInfo* vi = (XVisualInfo*)malloc(sizeof(XVisualInfo));
    if (!vi) return 0;
    memset(vi, 0, sizeof(*vi));
    vi->depth = 24; vi->c_class = 4 /*TrueColor*/; vi->bits_per_rgb = 8;
    vi->red_mask = 0xff0000; vi->green_mask = 0x00ff00; vi->blue_mask = 0x0000ff;
    vi->visualid = 0x21; vi->colormap_size = 256;
    return vi;
}
API GLXContext glXCreateContext(Display* dpy, XVisualInfo* vis, GLXContext share, int direct) {
    GL64Args a = {{0}}; a.a[0]=(uint64_t)(uintptr_t)vis; a.a[1]=(uint64_t)(uintptr_t)share; a.a[2]=(uint64_t)direct;
    return (GLXContext)(uintptr_t)gl64_trap(GL64_fn_glXCreateContext, &a);
}
API GLXContext glXCreateContextAttribsARB(Display* dpy, GLXFBConfig config, GLXContext share, int direct, const int* attribs) {
    GL64Args a = {{0}}; a.a[0]=(uint64_t)(uintptr_t)config; a.a[1]=(uint64_t)(uintptr_t)share;
    a.a[2]=(uint64_t)direct; a.a[3]=(uint64_t)(uintptr_t)attribs;
    return (GLXContext)(uintptr_t)gl64_trap(GL64_fn_glXCreateContextAttribsARB, &a);
}
API GLXContext glXCreateNewContext(Display* dpy, GLXFBConfig config, int renderType, GLXContext share, int direct) {
    GL64Args a = {{0}}; a.a[0]=(uint64_t)(uintptr_t)config; a.a[1]=(uint64_t)(uintptr_t)share; a.a[2]=(uint64_t)direct;
    return (GLXContext)(uintptr_t)gl64_trap(GL64_fn_glXCreateContext, &a);
}
// glXChooseFBConfig/glXGetFBConfigs return an array wine XFree()s — so malloc a
// 1-element array of opaque config ids (NOT a static, which wine would invalid-
// free). The element is an opaque id the host bridge tracks; winex11's [i] read
// stays in this guest buffer.
API GLXFBConfig* glXChooseFBConfig(Display* dpy, int screen, const int* attribs, int* nelements) {
    GL64Args a = {{0}}; a.a[0]=(uint64_t)screen; a.a[1]=(uint64_t)(uintptr_t)attribs; a.a[2]=(uint64_t)(uintptr_t)nelements;
    uint64_t id = gl64_trap(GL64_fn_glXChooseFBConfig, &a);
    GLXFBConfig* arr = (GLXFBConfig*)malloc(sizeof(GLXFBConfig));
    if (!arr) { if (nelements) *nelements = 0; return 0; }
    arr[0] = (GLXFBConfig)(uintptr_t)id;
    if (nelements) *nelements = 1;
    return arr;
}
API GLXFBConfig* glXGetFBConfigs(Display* dpy, int screen, int* nelements) {
    GL64Args a = {{0}}; a.a[0]=(uint64_t)screen; a.a[1]=(uint64_t)(uintptr_t)nelements;
    uint64_t id = gl64_trap(GL64_fn_glXGetFBConfigs, &a);
    GLXFBConfig* arr = (GLXFBConfig*)malloc(sizeof(GLXFBConfig));
    if (!arr) { if (nelements) *nelements = 0; return 0; }
    arr[0] = (GLXFBConfig)(uintptr_t)id;
    if (nelements) *nelements = 1;
    return arr;
}
API int glXGetFBConfigAttrib(Display* dpy, GLXFBConfig config, int attribute, int* value) {
    GL64Args a = {{0}}; a.a[0]=(uint64_t)(uintptr_t)config; a.a[1]=(uint64_t)attribute; a.a[2]=(uint64_t)(uintptr_t)value;
    return (int)gl64_trap(GL64_fn_glXGetFBConfigAttrib, &a);
}
API XVisualInfo* glXGetVisualFromFBConfig(Display* dpy, GLXFBConfig config) {
    return glXChooseVisual(dpy, 0, 0);
}
API int glXGetConfig(Display* dpy, XVisualInfo* vis, int attribute, int* value) {
    GL64Args a = {{0}}; a.a[0]=(uint64_t)(uintptr_t)vis; a.a[1]=(uint64_t)attribute; a.a[2]=(uint64_t)(uintptr_t)value;
    return (int)gl64_trap(GL64_fn_glXGetConfig, &a);
}
API GLboolean glXMakeCurrent(Display* dpy, GLXDrawable drawable, GLXContext ctx) {
    GL64Args a = {{0}}; a.a[0]=(uint64_t)drawable; a.a[1]=(uint64_t)(uintptr_t)ctx;
    return (GLboolean)gl64_trap(GL64_fn_glXMakeCurrent, &a);
}
API GLboolean glXMakeContextCurrent(Display* dpy, GLXDrawable draw, GLXDrawable read, GLXContext ctx) {
    GL64Args a = {{0}}; a.a[0]=(uint64_t)draw; a.a[1]=(uint64_t)read; a.a[2]=(uint64_t)(uintptr_t)ctx;
    return (GLboolean)gl64_trap(GL64_fn_glXMakeContextCurrent, &a);
}
API void glXSwapBuffers(Display* dpy, GLXDrawable drawable) {
    GL64Args a = {{0}}; a.a[0]=(uint64_t)drawable;
    (void)gl64_trap(GL64_fn_glXSwapBuffers, &a);
}
API void glXDestroyContext(Display* dpy, GLXContext ctx) {
    GL64Args a = {{0}}; a.a[0]=(uint64_t)(uintptr_t)ctx;
    (void)gl64_trap(GL64_fn_glXDestroyContext, &a);
}
API GLboolean glXIsDirect(Display* dpy, GLXContext ctx) {
    return (GLboolean)gl64_trap(GL64_fn_glXIsDirect, 0);
}
API GLXContext glXGetCurrentContext(void) {
    return (GLXContext)(uintptr_t)gl64_trap(GL64_fn_glXGetCurrentContext, 0);
}
API GLXDrawable glXGetCurrentDrawable(void) {
    return (GLXDrawable)gl64_trap(GL64_fn_glXGetCurrentDrawable, 0);
}
API void glXWaitGL(void) { (void)gl64_trap(GL64_fn_glXWaitGL, 0); }
API void glXWaitX(void)  { (void)gl64_trap(GL64_fn_glXWaitX, 0); }
API void glXSwapIntervalEXT(Display* dpy, GLXDrawable d, int interval) {
    GL64Args a = {{0}}; a.a[0]=(uint64_t)d; a.a[1]=(uint64_t)interval;
    (void)gl64_trap(GL64_fn_glXSwapIntervalEXT, &a);
}
API int glXSwapIntervalMESA(unsigned int interval) { return 0; }
API int glXSwapIntervalSGI(int interval) { return 0; }

// ===========================================================================
// core GL
// ===========================================================================
API void glClearColor(GLclampf r, GLclampf g, GLclampf b, GLclampf al) {
    GL64Args a = {{0}}; a.a[0]=F2U(r); a.a[1]=F2U(g); a.a[2]=F2U(b); a.a[3]=F2U(al);
    (void)gl64_trap(GL64_fn_glClearColor, &a);
}
API void glClear(GLbitfield mask) {
    GL64Args a = {{0}}; a.a[0]=mask; (void)gl64_trap(GL64_fn_glClear, &a);
}
API void glClearDepth(GLclampd depth) {
    GL64Args a = {{0}}; a.a[0]=D2U(depth); (void)gl64_trap(GL64_fn_glClearDepth, &a);
}
API void glViewport(GLint x, GLint y, GLsizei w, GLsizei h) {
    GL64Args a = {{0}}; a.a[0]=(uint64_t)(uint32_t)x; a.a[1]=(uint64_t)(uint32_t)y; a.a[2]=(uint64_t)(uint32_t)w; a.a[3]=(uint64_t)(uint32_t)h;
    (void)gl64_trap(GL64_fn_glViewport, &a);
}
API void glEnable(GLenum c)  { GL64Args a={{0}}; a.a[0]=c; (void)gl64_trap(GL64_fn_glEnable,&a); }
API void glDisable(GLenum c) { GL64Args a={{0}}; a.a[0]=c; (void)gl64_trap(GL64_fn_glDisable,&a); }
API void glShadeModel(GLenum m){ GL64Args a={{0}}; a.a[0]=m; (void)gl64_trap(GL64_fn_glShadeModel,&a); }
API void glDepthFunc(GLenum f){ GL64Args a={{0}}; a.a[0]=f; (void)gl64_trap(GL64_fn_glDepthFunc,&a); }
API void glCullFace(GLenum m) { GL64Args a={{0}}; a.a[0]=m; (void)gl64_trap(GL64_fn_glCullFace,&a); }
API void glFrontFace(GLenum m){ GL64Args a={{0}}; a.a[0]=m; (void)gl64_trap(GL64_fn_glFrontFace,&a); }
API void glHint(GLenum t, GLenum m){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=m; (void)gl64_trap(GL64_fn_glHint,&a); }
API void glFlush(void) { (void)gl64_trap(GL64_fn_glFlush,0); }
API void glFinish(void){ (void)gl64_trap(GL64_fn_glFinish,0); }
API GLenum glGetError(void){ return (GLenum)gl64_trap(GL64_fn_glGetError,0); }
// Version mode: ask the host which GL profile to advertise. The host reads
// BW64_GLVERSION ("3*" -> 32, else 21); cached after the first query. This
// keeps D3D9-era apps on the proven 2.1 strings while D3D11 experiments opt
// into 3.2 core via ?glversion=3.2 — without any guest-libc dependency.
static int gl_version_mode(void) {
    static int cached = 0; // 0 = unknown, else 21, 32 or 33
    if (!cached) {
        uint64_t m = gl64_trap(GL64_fn_glVersionMode, 0);
        cached = (m == 33) ? 33 : (m == 32 ? 32 : 21);
    }
    return cached;
}
API const GLubyte* glGetString(GLenum name) {
    // Host returns the real string only as a host pointer (unusable in-guest),
    // so it returns 0 and we hand back our own stable strings.
    static const GLubyte* vendor   = (const GLubyte*)"Boxedwine64";
    static const GLubyte* renderer = (const GLubyte*)"Boxedwine64 GL (WebGL2)";
    // GL 2.1 + a rich ARB extension list so wined3d's GLSL renderer backend
    // activates (it picks GLSL when ARB_shader_objects + GLSL 1.20 are present)
    // and so it sees the VBO / FBO / multitexture / NPOT / depth-texture caps it
    // needs to emit a draw. With an EMPTY extension string wined3d concluded the
    // driver had no usable feature set and never issued DrawPrimitive (the clear
    // showed, the triangle never did). These all map onto WebGL2/GLES3 features.
    static const GLubyte* version21 = (const GLubyte*)"2.1 Boxedwine64";
    static const GLubyte* version32 = (const GLubyte*)"3.2 Boxedwine64";
    static const GLubyte* version33 = (const GLubyte*)"3.3 Boxedwine64";
    static const GLubyte* version  = (const GLubyte*)"2.1 Boxedwine64";
    static const GLubyte* slv12    = (const GLubyte*)"1.20";
    static const GLubyte* slv15    = (const GLubyte*)"1.50";
    static const GLubyte* slv      = (const GLubyte*)"1.20";
    int mode = gl_version_mode();
    if (mode == 33)      { version = version33; slv = (const GLubyte*)"3.30"; }
    else if (mode == 32) { version = version32; slv = slv15; }
    else                 { version = version21; slv = slv12; }
    // The monolithic GL_EXTENSIONS string (legacy/compat path). Must list the same
    // extensions as g_extList[] below (the core-profile glGetStringi path) so both
    // wined3d code paths see the same feature set.
    //
    // A2: the FBO / sampler-object / UBO / MRT / instancing extensions are now
    // GENUINELY implemented on the host (1:1 WebGL2), so advertising them is no
    // longer a lie — wined3d binds real pointers instead of gl64_noop.
    // GL_ARB_sampler_objects is the load-bearing one: wined3d's
    // feature_level_from_caps() gates every feature level >= 10_0 on it
    // (adapter_gl.c lists ARB_SAMPLER_OBJECTS at min GL 3.3), so without it
    // D3D11's requested 11_0 is refused and wined3d_device_create() fails.
    static const GLubyte* exts     = (const GLubyte*)
        "GL_ARB_multitexture GL_ARB_vertex_buffer_object GL_ARB_texture_non_power_of_two GL_ARB_shader_objects GL_ARB_shading_language_100 GL_ARB_vertex_shader GL_ARB_fragment_shader GL_ARB_sampler_objects GL_ARB_framebuffer_object GL_ARB_uniform_buffer_object GL_ARB_draw_buffers GL_ARB_instanced_arrays GL_ARB_polygon_offset_clamp GL_ARB_draw_buffers_blend GL_ARB_texture_cube_map_array GL_ARB_texture_storage GL_ARB_texture_storage_multisample";
    (void)gl64_trap(GL64_fn_glGetString, 0);
    switch (name) {
        case 0x1F00: return vendor;    // GL_VENDOR
        case 0x1F01: return renderer;  // GL_RENDERER
        case 0x1F02: return version;   // GL_VERSION
        case 0x1F03: return exts;      // GL_EXTENSIONS
        case 0x8B8C: return slv;       // GL_SHADING_LANGUAGE_VERSION
        default:     return exts;
    }
}

// The SAME extension set as the monolithic string above, as an indexable array
// for the GL 3.0+ core-profile enumeration path: glGetIntegerv(GL_NUM_EXTENSIONS)
// + glGetStringi(GL_EXTENSIONS, i). wined3d uses THIS path (it queries
// GL_NUM_EXTENSIONS), so an empty glGetStringi made it find no usable extensions
// and never issue a draw, even though the monolithic string was populated.
static const char* const g_extList[] = {
    // The MINIMAL set that lets wined3d create a GLSL device AND pass CreateDevice.
    // Bisected (M16): advertising the broader texture-format extensions
    // (texture_float / sRGB / s3tc / rectangle / occlusion) made wined3d run a
    // strict D3D-format validation that FAILS against WebGL2 → CreateDevice
    // returned D3DERR_NOTAVAILABLE. Keep the monolithic GL_EXTENSIONS string
    // (glGetString) in sync with this.
    // A2: framebuffer_object / uniform_buffer_object / draw_buffers /
    // instanced_arrays / sampler_objects are now REAL on the host, so the old
    // "advertise FBO → format validation fails" objection no longer applies to
    // them: they only turn on wined3d code paths, they do not declare a texture
    // format we cannot back. sampler_objects is required for FL >= 10_0.
    "GL_ARB_multitexture","GL_ARB_vertex_buffer_object","GL_ARB_texture_non_power_of_two",
    "GL_ARB_shader_objects","GL_ARB_shading_language_100",
    "GL_ARB_vertex_shader","GL_ARB_fragment_shader",
    "GL_ARB_sampler_objects","GL_ARB_framebuffer_object",
    "GL_ARB_uniform_buffer_object","GL_ARB_draw_buffers","GL_ARB_instanced_arrays",
    // A2 cycle 2. feature_level_from_caps() requires ALL THREE of
    // WINED3D_GL_VERSION_3_2 + ARB_POLYGON_OFFSET_CLAMP + ARB_SAMPLER_OBJECTS
    // before it returns any feature level >= 10_0; Unity's D3D11 path asks for
    // 11_0. polygon_offset_clamp is real (forwarded to glPolygonOffset with the
    // clamp dropped — WebGL2 has none), so advertising it is no longer a lie.
    // draw_buffers_blend and texture_cube_map_array lift the 10_0 branch to 10_1;
    // both are backed (indexed blend through GLctx, cube-map arrays by the real
    // glTexImage3D on GL_TEXTURE_CUBE_MAP_ARRAY).
    "GL_ARB_polygon_offset_clamp","GL_ARB_draw_buffers_blend",
    "GL_ARB_texture_cube_map_array",
    // C10: texture_storage (+_multisample) are now REAL on the host
    // (TexStorage1D/2D/3D via glTexStorage; 2D/3DMS via the identical
    // immutable multisample allocation). Advertising them lets wined3d keep
    // ARB_texture_multisample instead of disabling it for "immutable storage
    // is not supported" — verified against adapter_gl.c:3663.
    "GL_ARB_texture_storage","GL_ARB_texture_storage_multisample",
};
#define G_EXT_COUNT ((int)(sizeof(g_extList)/sizeof(g_extList[0])))

API void glGetIntegerv(GLenum pname, GLint* params) {
    // GL_NUM_EXTENSIONS: answer with OUR curated count guest-side. If we forwarded
    // to the host it would return WebGL2's own count (54), and wined3d would then
    // glGetStringi() through 54 host extensions that our guest can't name — so it
    // would see none of the features it needs. Keeping the count + the names in
    // sync (both from g_extList) is what lets wined3d's GLSL renderer come up.
    if (pname == 0x821D /*GL_NUM_EXTENSIONS*/) { if (params) params[0] = G_EXT_COUNT; return; }
    GL64Args a = {{0}}; a.a[0]=pname; a.a[1]=(uint64_t)(uintptr_t)params;
    (void)gl64_trap(GL64_fn_glGetIntegerv, &a);
}
API void glGetFloatv(GLenum pname, GLfloat* params) {
    GL64Args a = {{0}}; a.a[0]=pname; a.a[1]=(uint64_t)(uintptr_t)params;
    (void)gl64_trap(GL64_fn_glGetFloatv, &a);
}
API void glColor3f(GLfloat r,GLfloat g,GLfloat b){ GL64Args a={{0}}; a.a[0]=F2U(r);a.a[1]=F2U(g);a.a[2]=F2U(b); (void)gl64_trap(GL64_fn_glColor3f,&a); }
API void glColor4f(GLfloat r,GLfloat g,GLfloat b,GLfloat al){ GL64Args a={{0}}; a.a[0]=F2U(r);a.a[1]=F2U(g);a.a[2]=F2U(b);a.a[3]=F2U(al); (void)gl64_trap(GL64_fn_glColor4f,&a); }

API void glMatrixMode(GLenum m){ GL64Args a={{0}}; a.a[0]=m; (void)gl64_trap(GL64_fn_glMatrixMode,&a); }
API void glLoadIdentity(void){ (void)gl64_trap(GL64_fn_glLoadIdentity,0); }
API void glPushMatrix(void){ (void)gl64_trap(GL64_fn_glPushMatrix,0); }
API void glPopMatrix(void){ (void)gl64_trap(GL64_fn_glPopMatrix,0); }
API void glFrustum(GLdouble l,GLdouble r,GLdouble b,GLdouble t,GLdouble n,GLdouble f){
    GL64Args a={{0}}; a.a[0]=D2U(l);a.a[1]=D2U(r);a.a[2]=D2U(b);a.a[3]=D2U(t);a.a[4]=D2U(n);a.a[5]=D2U(f);
    (void)gl64_trap(GL64_fn_glFrustum,&a);
}
API void glOrtho(GLdouble l,GLdouble r,GLdouble b,GLdouble t,GLdouble n,GLdouble f){
    GL64Args a={{0}}; a.a[0]=D2U(l);a.a[1]=D2U(r);a.a[2]=D2U(b);a.a[3]=D2U(t);a.a[4]=D2U(n);a.a[5]=D2U(f);
    (void)gl64_trap(GL64_fn_glOrtho,&a);
}
API void glTranslatef(GLfloat x,GLfloat y,GLfloat z){ GL64Args a={{0}}; a.a[0]=F2U(x);a.a[1]=F2U(y);a.a[2]=F2U(z); (void)gl64_trap(GL64_fn_glTranslatef,&a); }
API void glRotatef(GLfloat ang,GLfloat x,GLfloat y,GLfloat z){ GL64Args a={{0}}; a.a[0]=F2U(ang);a.a[1]=F2U(x);a.a[2]=F2U(y);a.a[3]=F2U(z); (void)gl64_trap(GL64_fn_glRotatef,&a); }
API void glScalef(GLfloat x,GLfloat y,GLfloat z){ GL64Args a={{0}}; a.a[0]=F2U(x);a.a[1]=F2U(y);a.a[2]=F2U(z); (void)gl64_trap(GL64_fn_glScalef,&a); }
API void glMultMatrixf(const GLfloat* m){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uintptr_t)m; (void)gl64_trap(GL64_fn_glMultMatrixf,&a); }

API void glLightfv(GLenum light,GLenum pname,const GLfloat* params){ GL64Args a={{0}}; a.a[0]=light;a.a[1]=pname;a.a[2]=(uint64_t)(uintptr_t)params; (void)gl64_trap(GL64_fn_glLightfv,&a); }
API void glLightf(GLenum light,GLenum pname,GLfloat param){ GL64Args a={{0}}; a.a[0]=light;a.a[1]=pname;a.a[2]=F2U(param); (void)gl64_trap(GL64_fn_glLightf,&a); }
API void glMaterialfv(GLenum face,GLenum pname,const GLfloat* params){ GL64Args a={{0}}; a.a[0]=face;a.a[1]=pname;a.a[2]=(uint64_t)(uintptr_t)params; (void)gl64_trap(GL64_fn_glMaterialfv,&a); }
API void glMaterialf(GLenum face,GLenum pname,GLfloat param){ GL64Args a={{0}}; a.a[0]=face;a.a[1]=pname;a.a[2]=F2U(param); (void)gl64_trap(GL64_fn_glMaterialf,&a); }
API void glColorMaterial(GLenum face,GLenum mode){ GL64Args a={{0}}; a.a[0]=face;a.a[1]=mode; (void)gl64_trap(GL64_fn_glColorMaterial,&a); }
API void glNormal3f(GLfloat x,GLfloat y,GLfloat z){ GL64Args a={{0}}; a.a[0]=F2U(x);a.a[1]=F2U(y);a.a[2]=F2U(z); (void)gl64_trap(GL64_fn_glNormal3f,&a); }

API void glBegin(GLenum m){ GL64Args a={{0}}; a.a[0]=m; (void)gl64_trap(GL64_fn_glBegin,&a); }
API void glEnd(void){ (void)gl64_trap(GL64_fn_glEnd,0); }
API void glVertex2f(GLfloat x,GLfloat y){ GL64Args a={{0}}; a.a[0]=F2U(x);a.a[1]=F2U(y); (void)gl64_trap(GL64_fn_glVertex2f,&a); }
API void glVertex3f(GLfloat x,GLfloat y,GLfloat z){ GL64Args a={{0}}; a.a[0]=F2U(x);a.a[1]=F2U(y);a.a[2]=F2U(z); (void)gl64_trap(GL64_fn_glVertex3f,&a); }

// ===========================================================================
// Programmable pipeline (GL2 / GLES3) — the modern entry points wined3d needs.
// Extra typedefs the FFP block above didn't require.
// ===========================================================================
typedef unsigned int   GLuint;
typedef char           GLchar;
typedef long           GLsizeiptr;   // 64-bit on x86_64-linux
typedef long           GLintptr;
typedef unsigned int   GLuintptr;

// --- shaders / programs ---
API GLuint glCreateShader(GLenum type){ GL64Args a={{0}}; a.a[0]=type; return (GLuint)gl64_trap(GL64_fn_glCreateShader,&a); }
API void glShaderSource(GLuint sh, GLsizei count, const GLchar* const* string, const GLint* length){
    GL64Args a={{0}}; a.a[0]=sh; a.a[1]=(uint64_t)(uint32_t)count;
    a.a[2]=(uint64_t)(uintptr_t)string; a.a[3]=(uint64_t)(uintptr_t)length;
    (void)gl64_trap(GL64_fn_glShaderSource,&a);
}
API void glCompileShader(GLuint sh){ GL64Args a={{0}}; a.a[0]=sh; (void)gl64_trap(GL64_fn_glCompileShader,&a); }
API void glGetShaderiv(GLuint sh, GLenum pname, GLint* params){ GL64Args a={{0}}; a.a[0]=sh; a.a[1]=pname; a.a[2]=(uint64_t)(uintptr_t)params; (void)gl64_trap(GL64_fn_glGetShaderiv,&a); }
API void glGetShaderInfoLog(GLuint sh, GLsizei bufSize, GLsizei* length, GLchar* infoLog){
    GL64Args a={{0}}; a.a[0]=sh; a.a[1]=(uint64_t)(uint32_t)bufSize; a.a[2]=(uint64_t)(uintptr_t)length; a.a[3]=(uint64_t)(uintptr_t)infoLog;
    (void)gl64_trap(GL64_fn_glGetShaderInfoLog,&a);
}
API void glDeleteShader(GLuint sh){ GL64Args a={{0}}; a.a[0]=sh; (void)gl64_trap(GL64_fn_glDeleteShader,&a); }
API GLuint glCreateProgram(void){ return (GLuint)gl64_trap(GL64_fn_glCreateProgram,0); }
API void glAttachShader(GLuint p, GLuint sh){ GL64Args a={{0}}; a.a[0]=p; a.a[1]=sh; (void)gl64_trap(GL64_fn_glAttachShader,&a); }
API void glDetachShader(GLuint p, GLuint sh){ GL64Args a={{0}}; a.a[0]=p; a.a[1]=sh; (void)gl64_trap(GL64_fn_glDetachShader,&a); }
API void glBindAttribLocation(GLuint p, GLuint index, const GLchar* name){ GL64Args a={{0}}; a.a[0]=p; a.a[1]=index; a.a[2]=(uint64_t)(uintptr_t)name; (void)gl64_trap(GL64_fn_glBindAttribLocation,&a); }
API void glLinkProgram(GLuint p){ GL64Args a={{0}}; a.a[0]=p; (void)gl64_trap(GL64_fn_glLinkProgram,&a); }
API void glGetProgramiv(GLuint p, GLenum pname, GLint* params){ GL64Args a={{0}}; a.a[0]=p; a.a[1]=pname; a.a[2]=(uint64_t)(uintptr_t)params; (void)gl64_trap(GL64_fn_glGetProgramiv,&a); }
API void glGetProgramInfoLog(GLuint p, GLsizei bufSize, GLsizei* length, GLchar* infoLog){
    GL64Args a={{0}}; a.a[0]=p; a.a[1]=(uint64_t)(uint32_t)bufSize; a.a[2]=(uint64_t)(uintptr_t)length; a.a[3]=(uint64_t)(uintptr_t)infoLog;
    (void)gl64_trap(GL64_fn_glGetProgramInfoLog,&a);
}
API void glUseProgram(GLuint p){ GL64Args a={{0}}; a.a[0]=p; (void)gl64_trap(GL64_fn_glUseProgram,&a); }
API void glDeleteProgram(GLuint p){ GL64Args a={{0}}; a.a[0]=p; (void)gl64_trap(GL64_fn_glDeleteProgram,&a); }
API GLint glGetUniformLocation(GLuint p, const GLchar* name){ GL64Args a={{0}}; a.a[0]=p; a.a[1]=(uint64_t)(uintptr_t)name; return (GLint)gl64_trap(GL64_fn_glGetUniformLocation,&a); }
API GLint glGetAttribLocation(GLuint p, const GLchar* name){ GL64Args a={{0}}; a.a[0]=p; a.a[1]=(uint64_t)(uintptr_t)name; return (GLint)gl64_trap(GL64_fn_glGetAttribLocation,&a); }
API void glValidateProgram(GLuint p){ GL64Args a={{0}}; a.a[0]=p; (void)gl64_trap(GL64_fn_glValidateProgram,&a); }

// --- uniforms ---
API void glUniform1i(GLint l, GLint v0){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)l; a.a[1]=(uint64_t)(uint32_t)v0; (void)gl64_trap(GL64_fn_glUniform1i,&a); }
API void glUniform1f(GLint l, GLfloat v0){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)l; a.a[1]=F2U(v0); (void)gl64_trap(GL64_fn_glUniform1f,&a); }
API void glUniform2f(GLint l, GLfloat v0, GLfloat v1){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)l; a.a[1]=F2U(v0); a.a[2]=F2U(v1); (void)gl64_trap(GL64_fn_glUniform2f,&a); }
API void glUniform3f(GLint l, GLfloat v0, GLfloat v1, GLfloat v2){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)l; a.a[1]=F2U(v0); a.a[2]=F2U(v1); a.a[3]=F2U(v2); (void)gl64_trap(GL64_fn_glUniform3f,&a); }
API void glUniform4f(GLint l, GLfloat v0, GLfloat v1, GLfloat v2, GLfloat v3){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)l; a.a[1]=F2U(v0); a.a[2]=F2U(v1); a.a[3]=F2U(v2); a.a[4]=F2U(v3); (void)gl64_trap(GL64_fn_glUniform4f,&a); }
API void glUniform1fv(GLint l, GLsizei n, const GLfloat* v){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)l; a.a[1]=(uint64_t)(uint32_t)n; a.a[2]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glUniform1fv,&a); }
API void glUniform2fv(GLint l, GLsizei n, const GLfloat* v){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)l; a.a[1]=(uint64_t)(uint32_t)n; a.a[2]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glUniform2fv,&a); }
API void glUniform3fv(GLint l, GLsizei n, const GLfloat* v){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)l; a.a[1]=(uint64_t)(uint32_t)n; a.a[2]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glUniform3fv,&a); }
API void glUniform4fv(GLint l, GLsizei n, const GLfloat* v){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)l; a.a[1]=(uint64_t)(uint32_t)n; a.a[2]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glUniform4fv,&a); }
API void glUniform1iv(GLint l, GLsizei n, const GLint* v){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)l; a.a[1]=(uint64_t)(uint32_t)n; a.a[2]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glUniform1iv,&a); }
API void glUniformMatrix2fv(GLint l, GLsizei n, GLboolean tr, const GLfloat* v){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)l; a.a[1]=(uint64_t)(uint32_t)n; a.a[2]=tr; a.a[3]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glUniformMatrix2fv,&a); }
API void glUniformMatrix3fv(GLint l, GLsizei n, GLboolean tr, const GLfloat* v){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)l; a.a[1]=(uint64_t)(uint32_t)n; a.a[2]=tr; a.a[3]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glUniformMatrix3fv,&a); }
API void glUniformMatrix4fv(GLint l, GLsizei n, GLboolean tr, const GLfloat* v){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)l; a.a[1]=(uint64_t)(uint32_t)n; a.a[2]=tr; a.a[3]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glUniformMatrix4fv,&a); }

// --- buffers ---
API void glGenBuffers(GLsizei n, GLuint* buffers){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)n; a.a[1]=(uint64_t)(uintptr_t)buffers; (void)gl64_trap(GL64_fn_glGenBuffers,&a); }
// Per-target buffer bookkeeping (defined here so glBufferData can record the size
// the whole-buffer glMapBuffer needs to flush the right amount on unmap).
#define GL_ARRAY_BUFFER_          0x8892
#define GL_ELEMENT_ARRAY_BUFFER_  0x8893
static struct { GLsizeiptr bufSize; GLintptr off; GLsizeiptr len; int active; } g_mapArray, g_mapElem;

API void glBufferData(GLenum target, GLsizeiptr size, const void* data, GLenum usage){
    if (target == GL_ELEMENT_ARRAY_BUFFER_) g_mapElem.bufSize = size; else if (target == GL_ARRAY_BUFFER_) g_mapArray.bufSize = size;
    GL64Args a={{0}}; a.a[0]=target; a.a[1]=(uint64_t)size; a.a[2]=(uint64_t)(uintptr_t)data; a.a[3]=usage; (void)gl64_trap(GL64_fn_glBufferData,&a); }
API void glBufferSubData(GLenum target, GLintptr offset, GLsizeiptr size, const void* data){ GL64Args a={{0}}; a.a[0]=target; a.a[1]=(uint64_t)offset; a.a[2]=(uint64_t)size; a.a[3]=(uint64_t)(uintptr_t)data; (void)gl64_trap(GL64_fn_glBufferSubData,&a); }
API void glDeleteBuffers(GLsizei n, const GLuint* buffers){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)n; a.a[1]=(uint64_t)(uintptr_t)buffers; (void)gl64_trap(GL64_fn_glDeleteBuffers,&a); }

// WebGL2 has no client-side buffer mapping. wined3d fills its (dynamic AND static)
// vertex/index buffers via glMapBufferRange → write → glUnmapBuffer. The old stub
// returned 0 for the map, so wined3d's writes went nowhere and the VBO stayed
// zero-filled → every vertex collapsed to one clip point → the D3D triangle was
// invisible (M16 #114). Emulate the map client-side: hand back a static scratch the
// guest writes into, remember (target, offset, length), and on glUnmapBuffer push
// the scratch into the real buffer via the (bridged) glBufferSubData. One active
// map per target is enough — wined3d unmaps before mapping the same target again.
#define GL64_MAP_SCRATCH (8u*1024u*1024u)   // per-target scratch; covers typical VBO maps
static unsigned char g_mapScratchArray[GL64_MAP_SCRATCH];
static unsigned char g_mapScratchElem[GL64_MAP_SCRATCH];
// g_mapArray/g_mapElem (bufSize/off/len/active) are declared up by glBufferData so it
// can record each buffer's size — glMapBuffer (whole-buffer, no length arg) MUST flush
// exactly that size on unmap; flushing the full scratch overruns the real VBO and
// glBufferSubData fails (GL_INVALID_VALUE), leaving the VBO empty (#119).

static unsigned char* gl64_map_scratch_for(GLenum target){
    if (target == GL_ELEMENT_ARRAY_BUFFER_) return g_mapScratchElem;
    return g_mapScratchArray; /* default: array buffer */
}
API void glBindBuffer(GLenum target, GLuint buffer){ GL64Args a={{0}}; a.a[0]=target; a.a[1]=buffer; (void)gl64_trap(GL64_fn_glBindBuffer,&a); }
API void* glMapBufferRange(GLenum target, GLintptr offset, GLsizeiptr length, GLbitfield access){
    (void)access;
    if (length <= 0 || (uint64_t)length > GL64_MAP_SCRATCH) return 0;
    unsigned char* p = gl64_map_scratch_for(target);
    if (target == GL_ELEMENT_ARRAY_BUFFER_) { g_mapElem.off=offset; g_mapElem.len=length; g_mapElem.active=1; }
    else                                    { g_mapArray.off=offset; g_mapArray.len=length; g_mapArray.active=1; }
    return p; /* wined3d writes its vertices/indices here; flushed on glUnmapBuffer */
}
API void* glMapBuffer(GLenum target, GLenum access){
    /* Whole-buffer map: flush the WHOLE bound buffer (its glBufferData size) on unmap. */
    (void)access;
    unsigned char* p = gl64_map_scratch_for(target);
    if (target == GL_ELEMENT_ARRAY_BUFFER_) {
        GLsizeiptr s = g_mapElem.bufSize; if (s<=0||(uint64_t)s>GL64_MAP_SCRATCH) return 0;
        g_mapElem.off=0; g_mapElem.len=s; g_mapElem.active=1;
    } else {
        GLsizeiptr s = g_mapArray.bufSize; if (s<=0||(uint64_t)s>GL64_MAP_SCRATCH) return 0;
        g_mapArray.off=0; g_mapArray.len=s; g_mapArray.active=1;
    }
    return p;
}
API GLboolean glUnmapBuffer(GLenum target){
    if (target == GL_ELEMENT_ARRAY_BUFFER_) {
        if (!g_mapElem.active) return 1;
        glBufferSubData(target, g_mapElem.off, g_mapElem.len, g_mapScratchElem);
        g_mapElem.active = 0;
    } else {
        if (!g_mapArray.active) return 1;
        glBufferSubData(target, g_mapArray.off, g_mapArray.len, g_mapScratchArray);
        g_mapArray.active = 0;
    }
    return 1; /* GL_TRUE */
}
API void glFlushMappedBufferRange(GLenum target, GLintptr offset, GLsizeiptr length){
    /* Explicit-flush maps (GL_MAP_FLUSH_EXPLICIT_BIT): push just this sub-range now. */
    unsigned char* p = gl64_map_scratch_for(target);
    if (length > 0 && (uint64_t)(offset+length) <= GL64_MAP_SCRATCH)
        glBufferSubData(target, offset, length, p + offset);
}

// ARB_vertex_buffer_object entry points. We advertise GL_ARB_vertex_buffer_object,
// so wine's GL_EXTCALL loader may resolve the *ARB-suffixed* names rather than the
// GL-1.5 core ones. Alias them to the core impls so wined3d's Lock/Unlock buffer
// fill (glMapBufferARB→write→glUnmapBufferARB) actually reaches the VBO. Without
// these the map resolved to NULL and the vertices were never uploaded (M16 #115).
API void  glGenBuffersARB(GLsizei n, GLuint* b){ glGenBuffers(n,b); }
API void  glBindBufferARB(GLenum t, GLuint b){ glBindBuffer(t,b); }
API void  glBufferDataARB(GLenum t, GLsizeiptr s, const void* d, GLenum u){ glBufferData(t,s,d,u); }
API void  glBufferSubDataARB(GLenum t, GLintptr o, GLsizeiptr s, const void* d){ glBufferSubData(t,o,s,d); }
API void  glDeleteBuffersARB(GLsizei n, const GLuint* b){ glDeleteBuffers(n,b); }
API void* glMapBufferARB(GLenum t, GLenum a){ return glMapBuffer(t,a); }
API GLboolean glUnmapBufferARB(GLenum t){ return glUnmapBuffer(t); }

// --- vertex attrib arrays / VAO ---
API void glEnableVertexAttribArray(GLuint index){ GL64Args a={{0}}; a.a[0]=index; (void)gl64_trap(GL64_fn_glEnableVertexAttribArray,&a); }
API void glDisableVertexAttribArray(GLuint index){ GL64Args a={{0}}; a.a[0]=index; (void)gl64_trap(GL64_fn_glDisableVertexAttribArray,&a); }
API void glVertexAttribPointer(GLuint index, GLint size, GLenum type, GLboolean norm, GLsizei stride, const void* ptr){
    GL64Args a={{0}}; a.a[0]=index; a.a[1]=(uint64_t)(uint32_t)size; a.a[2]=type; a.a[3]=norm; a.a[4]=(uint64_t)(uint32_t)stride; a.a[5]=(uint64_t)(uintptr_t)ptr;
    (void)gl64_trap(GL64_fn_glVertexAttribPointer,&a);
}
API void glGenVertexArrays(GLsizei n, GLuint* arrays){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)n; a.a[1]=(uint64_t)(uintptr_t)arrays; (void)gl64_trap(GL64_fn_glGenVertexArrays,&a); }
API void glBindVertexArray(GLuint array){ GL64Args a={{0}}; a.a[0]=array; (void)gl64_trap(GL64_fn_glBindVertexArray,&a); }
API void glDeleteVertexArrays(GLsizei n, const GLuint* arrays){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)n; a.a[1]=(uint64_t)(uintptr_t)arrays; (void)gl64_trap(GL64_fn_glDeleteVertexArrays,&a); }
API void glVertexAttrib4f(GLuint index, GLfloat x, GLfloat y, GLfloat z, GLfloat w){ GL64Args a={{0}}; a.a[0]=index; a.a[1]=F2U(x); a.a[2]=F2U(y); a.a[3]=F2U(z); a.a[4]=F2U(w); (void)gl64_trap(GL64_fn_glVertexAttrib4f,&a); }

// --- draws ---
API void glDrawArrays(GLenum mode, GLint first, GLsizei count){ GL64Args a={{0}}; a.a[0]=mode; a.a[1]=(uint64_t)(uint32_t)first; a.a[2]=(uint64_t)(uint32_t)count; (void)gl64_trap(GL64_fn_glDrawArrays,&a); }
API void glDrawElements(GLenum mode, GLsizei count, GLenum type, const void* indices){ GL64Args a={{0}}; a.a[0]=mode; a.a[1]=(uint64_t)(uint32_t)count; a.a[2]=type; a.a[3]=(uint64_t)(uintptr_t)indices; (void)gl64_trap(GL64_fn_glDrawElements,&a); }
API void glDrawRangeElements(GLenum mode, GLuint start, GLuint end, GLsizei count, GLenum type, const void* indices){ GL64Args a={{0}}; a.a[0]=mode; a.a[1]=start; a.a[2]=end; a.a[3]=(uint64_t)(uint32_t)count; a.a[4]=type; a.a[5]=(uint64_t)(uintptr_t)indices; (void)gl64_trap(GL64_fn_glDrawRangeElements,&a); }

// --- modern state ---
API void glBlendFunc(GLenum s, GLenum d){ GL64Args a={{0}}; a.a[0]=s; a.a[1]=d; (void)gl64_trap(GL64_fn_glBlendFunc,&a); }
API void glBlendFuncSeparate(GLenum sR, GLenum dR, GLenum sA, GLenum dA){ GL64Args a={{0}}; a.a[0]=sR; a.a[1]=dR; a.a[2]=sA; a.a[3]=dA; (void)gl64_trap(GL64_fn_glBlendFuncSeparate,&a); }
API void glBlendEquation(GLenum m){ GL64Args a={{0}}; a.a[0]=m; (void)gl64_trap(GL64_fn_glBlendEquation,&a); }
API void glBlendEquationSeparate(GLenum mR, GLenum mA){ GL64Args a={{0}}; a.a[0]=mR; a.a[1]=mA; (void)gl64_trap(GL64_fn_glBlendEquationSeparate,&a); }
API void glBlendColor(GLfloat r, GLfloat g, GLfloat b, GLfloat al){ GL64Args a={{0}}; a.a[0]=F2U(r); a.a[1]=F2U(g); a.a[2]=F2U(b); a.a[3]=F2U(al); (void)gl64_trap(GL64_fn_glBlendColor,&a); }
API void glColorMask(GLboolean r, GLboolean g, GLboolean b, GLboolean al){ GL64Args a={{0}}; a.a[0]=r; a.a[1]=g; a.a[2]=b; a.a[3]=al; (void)gl64_trap(GL64_fn_glColorMask,&a); }
API void glDepthMask(GLboolean f){ GL64Args a={{0}}; a.a[0]=f; (void)gl64_trap(GL64_fn_glDepthMask,&a); }
API void glStencilFunc(GLenum func, GLint ref, GLuint mask){ GL64Args a={{0}}; a.a[0]=func; a.a[1]=(uint64_t)(uint32_t)ref; a.a[2]=mask; (void)gl64_trap(GL64_fn_glStencilFunc,&a); }
API void glStencilOp(GLenum f, GLenum zf, GLenum zp){ GL64Args a={{0}}; a.a[0]=f; a.a[1]=zf; a.a[2]=zp; (void)gl64_trap(GL64_fn_glStencilOp,&a); }
API void glStencilMask(GLuint mask){ GL64Args a={{0}}; a.a[0]=mask; (void)gl64_trap(GL64_fn_glStencilMask,&a); }
API void glStencilFuncSeparate(GLenum face, GLenum func, GLint ref, GLuint mask){ GL64Args a={{0}}; a.a[0]=face; a.a[1]=func; a.a[2]=(uint64_t)(uint32_t)ref; a.a[3]=mask; (void)gl64_trap(GL64_fn_glStencilFuncSeparate,&a); }
API void glStencilOpSeparate(GLenum face, GLenum f, GLenum zf, GLenum zp){ GL64Args a={{0}}; a.a[0]=face; a.a[1]=f; a.a[2]=zf; a.a[3]=zp; (void)gl64_trap(GL64_fn_glStencilOpSeparate,&a); }
API void glStencilMaskSeparate(GLenum face, GLuint mask){ GL64Args a={{0}}; a.a[0]=face; a.a[1]=mask; (void)gl64_trap(GL64_fn_glStencilMaskSeparate,&a); }
API void glScissor(GLint x, GLint y, GLsizei w, GLsizei h){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)x; a.a[1]=(uint64_t)(uint32_t)y; a.a[2]=(uint64_t)(uint32_t)w; a.a[3]=(uint64_t)(uint32_t)h; (void)gl64_trap(GL64_fn_glScissor,&a); }
API void glPolygonOffset(GLfloat factor, GLfloat units){ GL64Args a={{0}}; a.a[0]=F2U(factor); a.a[1]=F2U(units); (void)gl64_trap(GL64_fn_glPolygonOffset,&a); }
API void glPolygonMode(GLenum face, GLenum mode){ GL64Args a={{0}}; a.a[0]=face; a.a[1]=mode; (void)gl64_trap(GL64_fn_glPolygonMode,&a); }
API void glDepthRange(GLclampd n, GLclampd f){ GL64Args a={{0}}; a.a[0]=D2U(n); a.a[1]=D2U(f); (void)gl64_trap(GL64_fn_glDepthRange,&a); }
API void glLineWidth(GLfloat w){ GL64Args a={{0}}; a.a[0]=F2U(w); (void)gl64_trap(GL64_fn_glLineWidth,&a); }
API void glPixelStorei(GLenum pname, GLint param){ GL64Args a={{0}}; a.a[0]=pname; a.a[1]=(uint64_t)(uint32_t)param; (void)gl64_trap(GL64_fn_glPixelStorei,&a); }
API void glSampleCoverage(GLfloat value, GLboolean invert){ GL64Args a={{0}}; a.a[0]=F2U(value); a.a[1]=invert; (void)gl64_trap(GL64_fn_glSampleCoverage,&a); }

API void glReadPixels(GLint x, GLint y, GLsizei w, GLsizei h, GLenum fmt, GLenum type, void* pixels){
    GL64Args a={{0}}; a.a[0]=(uint32_t)x; a.a[1]=(uint32_t)y; a.a[2]=(uint32_t)w; a.a[3]=(uint32_t)h; a.a[4]=fmt; a.a[5]=type; a.a[6]=(uintptr_t)pixels;
    (void)gl64_trap(GL64_fn_glReadPixels,&a);
}
API void glGetTexImage(GLenum target, GLint level, GLenum fmt, GLenum type, void* pixels){
    GL64Args a={{0}}; a.a[0]=target; a.a[1]=(uint32_t)level; a.a[2]=fmt; a.a[3]=type; a.a[4]=(uintptr_t)pixels;
    (void)gl64_trap(GL64_fn_glGetTexImage,&a);
}

// --- textures ---
API void glActiveTexture(GLenum texture){ GL64Args a={{0}}; a.a[0]=texture; (void)gl64_trap(GL64_fn_glActiveTexture,&a); }
API void glGenTextures(GLsizei n, GLuint* textures){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)n; a.a[1]=(uint64_t)(uintptr_t)textures; (void)gl64_trap(GL64_fn_glGenTextures,&a); }
API void glBindTexture(GLenum target, GLuint texture){ GL64Args a={{0}}; a.a[0]=target; a.a[1]=texture; (void)gl64_trap(GL64_fn_glBindTexture,&a); }
API void glDeleteTextures(GLsizei n, const GLuint* textures){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)n; a.a[1]=(uint64_t)(uintptr_t)textures; (void)gl64_trap(GL64_fn_glDeleteTextures,&a); }
API void glTexParameteri(GLenum target, GLenum pname, GLint param){ GL64Args a={{0}}; a.a[0]=target; a.a[1]=pname; a.a[2]=(uint64_t)(uint32_t)param; (void)gl64_trap(GL64_fn_glTexParameteri,&a); }
API void glTexParameterf(GLenum target, GLenum pname, GLfloat param){ GL64Args a={{0}}; a.a[0]=target; a.a[1]=pname; a.a[2]=F2U(param); (void)gl64_trap(GL64_fn_glTexParameterf,&a); }
API void glTexImage2D(GLenum target, GLint level, GLint ifmt, GLsizei w, GLsizei h, GLint border, GLenum fmt, GLenum type, const void* pixels){
    GL64Args a={{0}}; a.a[0]=target; a.a[1]=(uint64_t)(uint32_t)level; a.a[2]=(uint64_t)(uint32_t)ifmt; a.a[3]=(uint64_t)(uint32_t)w; a.a[4]=(uint64_t)(uint32_t)h; a.a[5]=(uint64_t)(uint32_t)border; a.a[6]=fmt; a.a[7]=type; a.a[8]=(uint64_t)(uintptr_t)pixels;
    (void)gl64_trap(GL64_fn_glTexImage2D,&a);
}
// WebGL2 has no 1D textures; hostTextureTarget maps GL_TEXTURE_1D to 2D.
API void glTexImage1D(GLenum target, GLint level, GLint ifmt, GLsizei w, GLint border, GLenum fmt, GLenum type, const void* pixels){
    glTexImage2D(target, level, ifmt, w, 1, border, fmt, type, pixels);
}
API void glTexSubImage2D(GLenum target, GLint level, GLint x, GLint y, GLsizei w, GLsizei h, GLenum fmt, GLenum type, const void* pixels){
    GL64Args a={{0}}; a.a[0]=target; a.a[1]=(uint64_t)(uint32_t)level; a.a[2]=(uint64_t)(uint32_t)x; a.a[3]=(uint64_t)(uint32_t)y; a.a[4]=(uint64_t)(uint32_t)w; a.a[5]=(uint64_t)(uint32_t)h; a.a[6]=fmt; a.a[7]=type; a.a[8]=(uint64_t)(uintptr_t)pixels;
    (void)gl64_trap(GL64_fn_glTexSubImage2D,&a);
}
API void glGenerateMipmap(GLenum target){ GL64Args a={{0}}; a.a[0]=target; (void)gl64_trap(GL64_fn_glGenerateMipmap,&a); }
API void glCompressedTexImage2D(GLenum target, GLint level, GLenum ifmt, GLsizei w, GLsizei h, GLint border, GLsizei imageSize, const void* data){
    GL64Args a={{0}}; a.a[0]=target; a.a[1]=(uint64_t)(uint32_t)level; a.a[2]=ifmt; a.a[3]=(uint64_t)(uint32_t)w; a.a[4]=(uint64_t)(uint32_t)h; a.a[5]=(uint64_t)(uint32_t)border; a.a[6]=(uint64_t)(uint32_t)imageSize; a.a[7]=(uint64_t)(uintptr_t)data;
    (void)gl64_trap(GL64_fn_glCompressedTexImage2D,&a);
}
API const GLubyte* glGetStringi(GLenum name, GLuint index){
    // GL 3.0+ extension enumeration: return the i-th name from our curated list
    // (the same set as the monolithic GL_EXTENSIONS string). wined3d walks this
    // to decide which renderer features are available.
    if (name == 0x1F03 /*GL_EXTENSIONS*/ && (int)index < G_EXT_COUNT)
        return (const GLubyte*)g_extList[index];
    return (const GLubyte*)"";
}

// --- ARB_sync (fence objects) ---------------------------------------------
// wined3d's Present/flush issues a fence then polls glClientWaitSync until it
// reports signaled. Our GL work is synchronous (glOnMain), so the host reports
// ALREADY_SIGNALED immediately, ending wined3d's wait loop. GLsync is an opaque
// pointer; we round-trip the host handle through a uint64_t.
typedef void* GLsync_t;
API GLsync_t glFenceSync(GLenum condition, GLbitfield flags){
    GL64Args a={{0}}; a.a[0]=condition; a.a[1]=flags;
    return (GLsync_t)(uintptr_t)gl64_trap(GL64_fn_glFenceSync,&a);
}
API GLenum glClientWaitSync(GLsync_t sync, GLbitfield flags, uint64_t timeout){
    GL64Args a={{0}}; a.a[0]=(uint64_t)(uintptr_t)sync; a.a[1]=flags; a.a[2]=timeout;
    return (GLenum)gl64_trap(GL64_fn_glClientWaitSync,&a);
}
API void glWaitSync(GLsync_t sync, GLbitfield flags, uint64_t timeout){
    GL64Args a={{0}}; a.a[0]=(uint64_t)(uintptr_t)sync; a.a[1]=flags; a.a[2]=timeout;
    (void)gl64_trap(GL64_fn_glWaitSync,&a);
}
API void glDeleteSync(GLsync_t sync){
    GL64Args a={{0}}; a.a[0]=(uint64_t)(uintptr_t)sync; (void)gl64_trap(GL64_fn_glDeleteSync,&a);
}
API GLboolean glIsSync(GLsync_t sync){
    GL64Args a={{0}}; a.a[0]=(uint64_t)(uintptr_t)sync; return (GLboolean)gl64_trap(GL64_fn_glIsSync,&a);
}
API void glGetSynciv(GLsync_t sync, GLenum pname, GLsizei bufSize, GLsizei* length, GLint* values){
    GL64Args a={{0}}; a.a[0]=(uint64_t)(uintptr_t)sync; a.a[1]=pname; a.a[2]=(uint64_t)(uint32_t)bufSize;
    a.a[3]=(uint64_t)(uintptr_t)length; a.a[4]=(uint64_t)(uintptr_t)values;
    (void)gl64_trap(GL64_fn_glGetSynciv,&a);
}

// --- occlusion / timer queries --------------------------------------------
API void glGenQueries(GLsizei n, GLuint* ids){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)n; a.a[1]=(uint64_t)(uintptr_t)ids; (void)gl64_trap(GL64_fn_glGenQueries,&a); }
API void glDeleteQueries(GLsizei n, const GLuint* ids){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)n; a.a[1]=(uint64_t)(uintptr_t)ids; (void)gl64_trap(GL64_fn_glDeleteQueries,&a); }
API GLboolean glIsQuery(GLuint id){ GL64Args a={{0}}; a.a[0]=id; return (GLboolean)gl64_trap(GL64_fn_glIsQuery,&a); }
API void glBeginQuery(GLenum target, GLuint id){ GL64Args a={{0}}; a.a[0]=target; a.a[1]=id; (void)gl64_trap(GL64_fn_glBeginQuery,&a); }
API void glEndQuery(GLenum target){ GL64Args a={{0}}; a.a[0]=target; (void)gl64_trap(GL64_fn_glEndQuery,&a); }
API void glQueryCounter(GLuint id, GLenum target){ GL64Args a={{0}}; a.a[0]=id; a.a[1]=target; (void)gl64_trap(GL64_fn_glQueryCounter,&a); }
API void glGetQueryiv(GLenum target, GLenum pname, GLint* params){ GL64Args a={{0}}; a.a[0]=target; a.a[1]=pname; a.a[2]=(uint64_t)(uintptr_t)params; (void)gl64_trap(GL64_fn_glGetQueryiv,&a); }
API void glGetQueryObjectiv(GLuint id, GLenum pname, GLint* params){ GL64Args a={{0}}; a.a[0]=id; a.a[1]=pname; a.a[2]=(uint64_t)(uintptr_t)params; (void)gl64_trap(GL64_fn_glGetQueryObjectiv,&a); }
API void glGetQueryObjectuiv(GLuint id, GLenum pname, GLuint* params){ GL64Args a={{0}}; a.a[0]=id; a.a[1]=pname; a.a[2]=(uint64_t)(uintptr_t)params; (void)gl64_trap(GL64_fn_glGetQueryObjectuiv,&a); }
API void glGetQueryObjectui64v(GLuint id, GLenum pname, uint64_t* params){ GL64Args a={{0}}; a.a[0]=id; a.a[1]=pname; a.a[2]=(uint64_t)(uintptr_t)params; (void)gl64_trap(GL64_fn_glGetQueryObjectui64v,&a); }

// ===========================================================================
// A2: the GL 3.x surface wined3d's wglGetProcAddress sweep binds unconditionally
// (adapter_gl.c load_gl_funcs: `USE_GL_FUNC(pfn) = wglGetProcAddress(#pfn)` with
// NO null check). Before this block every one of these resolved to gl64_noop, so
// wined3d believed FBO / sampler / UBO / MRT state worked while nothing reached
// the GPU — the direct cause of the D3D11CreateDevice E_FAIL. All are 1:1
// WebGL2 (GLES3) entry points on the host; the *EXT / *ARB spellings are thin
// aliases below so wined3d's fallback name lookups land on the same wrappers.
// ===========================================================================

// --- framebuffer objects ---
API void glGenFramebuffers(GLsizei n, GLuint* fb){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)n; a.a[1]=(uint64_t)(uintptr_t)fb; (void)gl64_trap(GL64_fn_glGenFramebuffers,&a); }
API void glDeleteFramebuffers(GLsizei n, const GLuint* fb){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)n; a.a[1]=(uint64_t)(uintptr_t)fb; (void)gl64_trap(GL64_fn_glDeleteFramebuffers,&a); }
API void glBindFramebuffer(GLenum target, GLuint fb){ GL64Args a={{0}}; a.a[0]=target; a.a[1]=fb; (void)gl64_trap(GL64_fn_glBindFramebuffer,&a); }
API GLboolean glIsFramebuffer(GLuint fb){ GL64Args a={{0}}; a.a[0]=fb; return (GLboolean)gl64_trap(GL64_fn_glIsFramebuffer,&a); }
API void glFramebufferTexture1D(GLenum t, GLenum att, GLenum tt, GLuint tex, GLint lvl){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=att; a.a[2]=tt; a.a[3]=tex; a.a[4]=(uint64_t)(uint32_t)lvl; (void)gl64_trap(GL64_fn_glFramebufferTexture1D,&a); }
API void glFramebufferTexture2D(GLenum t, GLenum att, GLenum tt, GLuint tex, GLint lvl){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=att; a.a[2]=tt; a.a[3]=tex; a.a[4]=(uint64_t)(uint32_t)lvl; (void)gl64_trap(GL64_fn_glFramebufferTexture2D,&a); }
API void glFramebufferTexture3D(GLenum t, GLenum att, GLenum tt, GLuint tex, GLint lvl, GLint z){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=att; a.a[2]=tt; a.a[3]=tex; a.a[4]=(uint64_t)(uint32_t)lvl; a.a[5]=(uint64_t)(uint32_t)z; (void)gl64_trap(GL64_fn_glFramebufferTexture3D,&a); }
API void glFramebufferTexture(GLenum t, GLenum att, GLuint tex, GLint lvl){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=att; a.a[2]=tex; a.a[3]=(uint64_t)(uint32_t)lvl; (void)gl64_trap(GL64_fn_glFramebufferTexture,&a); }
API void glFramebufferTextureLayer(GLenum t, GLenum att, GLuint tex, GLint lvl, GLint layer){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=att; a.a[2]=tex; a.a[3]=(uint64_t)(uint32_t)lvl; a.a[4]=(uint64_t)(uint32_t)layer; (void)gl64_trap(GL64_fn_glFramebufferTextureLayer,&a); }
API void glFramebufferRenderbuffer(GLenum t, GLenum att, GLenum rbt, GLuint rb){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=att; a.a[2]=rbt; a.a[3]=rb; (void)gl64_trap(GL64_fn_glFramebufferRenderbuffer,&a); }
API GLenum glCheckFramebufferStatus(GLenum target){ GL64Args a={{0}}; a.a[0]=target; return (GLenum)gl64_trap(GL64_fn_glCheckFramebufferStatus,&a); }
API void glBlitFramebuffer(GLint sx0,GLint sy0,GLint sx1,GLint sy1,GLint dx0,GLint dy0,GLint dx1,GLint dy1,GLbitfield mask,GLenum filter){
    GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)sx0; a.a[1]=(uint64_t)(uint32_t)sy0; a.a[2]=(uint64_t)(uint32_t)sx1; a.a[3]=(uint64_t)(uint32_t)sy1;
    a.a[4]=(uint64_t)(uint32_t)dx0; a.a[5]=(uint64_t)(uint32_t)dy0; a.a[6]=(uint64_t)(uint32_t)dx1; a.a[7]=(uint64_t)(uint32_t)dy1;
    a.a[8]=mask; a.a[9]=filter; (void)gl64_trap(GL64_fn_glBlitFramebuffer,&a); }
API void glGenRenderbuffers(GLsizei n, GLuint* rb){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)n; a.a[1]=(uint64_t)(uintptr_t)rb; (void)gl64_trap(GL64_fn_glGenRenderbuffers,&a); }
API void glDeleteRenderbuffers(GLsizei n, const GLuint* rb){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)n; a.a[1]=(uint64_t)(uintptr_t)rb; (void)gl64_trap(GL64_fn_glDeleteRenderbuffers,&a); }
API void glBindRenderbuffer(GLenum t, GLuint rb){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=rb; (void)gl64_trap(GL64_fn_glBindRenderbuffer,&a); }
API void glRenderbufferStorage(GLenum t, GLenum ifmt, GLsizei w, GLsizei h){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=ifmt; a.a[2]=(uint64_t)(uint32_t)w; a.a[3]=(uint64_t)(uint32_t)h; (void)gl64_trap(GL64_fn_glRenderbufferStorage,&a); }
API void glRenderbufferStorageMultisample(GLenum t, GLsizei s, GLenum ifmt, GLsizei w, GLsizei h){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=(uint64_t)(uint32_t)s; a.a[2]=ifmt; a.a[3]=(uint64_t)(uint32_t)w; a.a[4]=(uint64_t)(uint32_t)h; (void)gl64_trap(GL64_fn_glRenderbufferStorageMultisample,&a); }
API GLboolean glIsRenderbuffer(GLuint rb){ GL64Args a={{0}}; a.a[0]=rb; return (GLboolean)gl64_trap(GL64_fn_glIsRenderbuffer,&a); }
API void glGetRenderbufferParameteriv(GLuint rb, GLenum pname, GLint* params){ GL64Args a={{0}}; a.a[0]=rb; a.a[1]=pname; a.a[2]=(uint64_t)(uintptr_t)params; (void)gl64_trap(GL64_fn_glGetRenderbufferParameteriv,&a); }
API void glGetFramebufferAttachmentParameteriv(GLenum t, GLenum att, GLenum pname, GLint* params){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=att; a.a[2]=pname; a.a[3]=(uint64_t)(uintptr_t)params; (void)gl64_trap(GL64_fn_glGetFramebufferAttachmentParameteriv,&a); }
API void glDrawBuffers(GLsizei n, const GLenum* bufs){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)n; a.a[1]=(uint64_t)(uintptr_t)bufs; (void)gl64_trap(GL64_fn_glDrawBuffers,&a); }
API void glReadBuffer(GLenum src){ GL64Args a={{0}}; a.a[0]=src; (void)gl64_trap(GL64_fn_glReadBuffer,&a); }

// ARB_framebuffer_object / EXT_framebuffer_object spelling aliases. WebGL2 has no
// EXT names, so alias them straight onto the core wrappers — wined3d's
// `fbo_ops` EXT fallback table (adapter_gl.c:3776+) then works unchanged.
API void glGenFramebuffersEXT(GLsizei n, GLuint* fb){ glGenFramebuffers(n, fb); }
API void glDeleteFramebuffersEXT(GLsizei n, const GLuint* fb){ glDeleteFramebuffers(n, fb); }
API void glBindFramebufferEXT(GLenum t, GLuint fb){ glBindFramebuffer(t, fb); }
API GLboolean glIsFramebufferEXT(GLuint fb){ return glIsFramebuffer(fb); }
API void glFramebufferTexture1DEXT(GLenum t, GLenum a, GLenum tt, GLuint tex, GLint l){ glFramebufferTexture1D(t,a,tt,tex,l); }
API void glFramebufferTexture2DEXT(GLenum t, GLenum a, GLenum tt, GLuint tex, GLint l){ glFramebufferTexture2D(t,a,tt,tex,l); }
API void glFramebufferTexture3DEXT(GLenum t, GLenum a, GLenum tt, GLuint tex, GLint lvl, GLint z){ glFramebufferTexture3D(t,a,tt,tex,lvl,z); }
API void glFramebufferRenderbufferEXT(GLenum t, GLenum a, GLenum rbt, GLuint rb){ glFramebufferRenderbuffer(t,a,rbt,rb); }
API GLenum glCheckFramebufferStatusEXT(GLenum t){ return glCheckFramebufferStatus(t); }
API void glBlitFramebufferEXT(GLint a0,GLint a1,GLint a2,GLint a3,GLint a4,GLint a5,GLint a6,GLint a7,GLbitfield m,GLenum f){ glBlitFramebuffer(a0,a1,a2,a3,a4,a5,a6,a7,m,f); }
API void glGetFramebufferAttachmentParameterivEXT(GLenum t, GLenum a, GLenum p, GLint* params){ glGetFramebufferAttachmentParameteriv(t,a,p,params); }
API void glGenRenderbuffersEXT(GLsizei n, GLuint* rb){ glGenRenderbuffers(n, rb); }
API void glDeleteRenderbuffersEXT(GLsizei n, const GLuint* rb){ glDeleteRenderbuffers(n, rb); }
API void glBindRenderbufferEXT(GLenum t, GLuint rb){ glBindRenderbuffer(t, rb); }
API void glRenderbufferStorageEXT(GLenum t, GLenum i, GLsizei w, GLsizei h){ glRenderbufferStorage(t,i,w,h); }
API void glRenderbufferStorageMultisampleEXT(GLenum t, GLsizei s, GLenum i, GLsizei w, GLsizei h){ glRenderbufferStorageMultisample(t,s,i,w,h); }
API GLboolean glIsRenderbufferEXT(GLuint rb){ return glIsRenderbuffer(rb); }
API void glGetRenderbufferParameterivEXT(GLuint rb, GLenum p, GLint* params){ glGetRenderbufferParameteriv(rb,p,params); }
API void glFramebufferTextureARB(GLenum t, GLenum a, GLuint tex, GLint l){ glFramebufferTexture(t,a,tex,l); }
API void glFramebufferTextureLayerARB(GLenum t, GLenum a, GLuint tex, GLint l, GLint layer){ glFramebufferTextureLayer(t,a,tex,l,layer); }
API void glFramebufferTexture2DARB(GLenum t, GLenum a, GLenum tt, GLuint tex, GLint l){ glFramebufferTexture2D(t,a,tt,tex,l); }
API void glFramebufferRenderbufferARB(GLenum t, GLenum a, GLenum rbt, GLuint rb){ glFramebufferRenderbuffer(t,a,rbt,rb); }

// --- sampler objects (GL 3.3 core / ARB_sampler_objects) ---
API void glGenSamplers(GLsizei n, GLuint* s){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)n; a.a[1]=(uint64_t)(uintptr_t)s; (void)gl64_trap(GL64_fn_glGenSamplers,&a); }
API void glDeleteSamplers(GLsizei n, const GLuint* s){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)n; a.a[1]=(uint64_t)(uintptr_t)s; (void)gl64_trap(GL64_fn_glDeleteSamplers,&a); }
API void glBindSampler(GLuint unit, GLuint sampler){ GL64Args a={{0}}; a.a[0]=unit; a.a[1]=sampler; (void)gl64_trap(GL64_fn_glBindSampler,&a); }
API GLboolean glIsSampler(GLuint s){ GL64Args a={{0}}; a.a[0]=s; return (GLboolean)gl64_trap(GL64_fn_glIsSampler,&a); }
API void glSamplerParameteri(GLuint s, GLenum pname, GLint param){ GL64Args a={{0}}; a.a[0]=s; a.a[1]=pname; a.a[2]=(uint64_t)(uint32_t)param; (void)gl64_trap(GL64_fn_glSamplerParameteri,&a); }
API void glSamplerParameterf(GLuint s, GLenum pname, GLfloat param){ GL64Args a={{0}}; a.a[0]=s; a.a[1]=pname; a.a[2]=F2U(param); (void)gl64_trap(GL64_fn_glSamplerParameterf,&a); }
API void glSamplerParameteriv(GLuint s, GLenum pname, const GLint* v){ GL64Args a={{0}}; a.a[0]=s; a.a[1]=pname; a.a[2]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glSamplerParameteriv,&a); }
API void glSamplerParameterfv(GLuint s, GLenum pname, const GLfloat* v){ GL64Args a={{0}}; a.a[0]=s; a.a[1]=pname; a.a[2]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glSamplerParameterfv,&a); }
API void glSamplerParameterIiv(GLuint s, GLenum pname, const GLint* v){ GL64Args a={{0}}; a.a[0]=s; a.a[1]=pname; a.a[2]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glSamplerParameterIiv,&a); }
API void glSamplerParameterIuiv(GLuint s, GLenum pname, const GLuint* v){ GL64Args a={{0}}; a.a[0]=s; a.a[1]=pname; a.a[2]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glSamplerParameterIuiv,&a); }
API void glGetSamplerParameteriv(GLuint s, GLenum pname, GLint* params){ GL64Args a={{0}}; a.a[0]=s; a.a[1]=pname; a.a[2]=(uint64_t)(uintptr_t)params; (void)gl64_trap(GL64_fn_glGetSamplerParameteriv,&a); }
API void glGetSamplerParameterfv(GLuint s, GLenum pname, GLfloat* params){ GL64Args a={{0}}; a.a[0]=s; a.a[1]=pname; a.a[2]=(uint64_t)(uintptr_t)params; (void)gl64_trap(GL64_fn_glGetSamplerParameterfv,&a); }
API void glGetSamplerParameterIiv(GLuint s, GLenum pname, GLint* params){ GL64Args a={{0}}; a.a[0]=s; a.a[1]=pname; a.a[2]=(uint64_t)(uintptr_t)params; (void)gl64_trap(GL64_fn_glGetSamplerParameterIiv,&a); }
API void glGetSamplerParameterIuiv(GLuint s, GLenum pname, GLuint* params){ GL64Args a={{0}}; a.a[0]=s; a.a[1]=pname; a.a[2]=(uint64_t)(uintptr_t)params; (void)gl64_trap(GL64_fn_glGetSamplerParameterIuiv,&a); }

// --- 3D / array textures ---
API void glTexImage3D(GLenum target, GLint level, GLint ifmt, GLsizei w, GLsizei h, GLsizei d, GLint border, GLenum fmt, GLenum type, const void* px){
    GL64Args a={{0}}; a.a[0]=target; a.a[1]=(uint64_t)(uint32_t)level; a.a[2]=(uint64_t)(uint32_t)ifmt; a.a[3]=(uint64_t)(uint32_t)w;
    a.a[4]=(uint64_t)(uint32_t)h; a.a[5]=(uint64_t)(uint32_t)d; a.a[6]=(uint64_t)(uint32_t)border; a.a[7]=fmt; a.a[8]=type; a.a[9]=(uint64_t)(uintptr_t)px;
    (void)gl64_trap(GL64_fn_glTexImage3D,&a); }
API void glTexSubImage3D(GLenum target, GLint level, GLint x, GLint y, GLint z, GLsizei w, GLsizei h, GLsizei d, GLenum fmt, GLenum type, const void* px){
    GL64Args a={{0}}; a.a[0]=target; a.a[1]=(uint64_t)(uint32_t)level; a.a[2]=(uint64_t)(uint32_t)x; a.a[3]=(uint64_t)(uint32_t)y;
    a.a[4]=(uint64_t)(uint32_t)z; a.a[5]=(uint64_t)(uint32_t)w; a.a[6]=(uint64_t)(uint32_t)h; a.a[7]=(uint64_t)(uint32_t)d;
    a.a[8]=fmt; a.a[9]=type; a.a[10]=(uint64_t)(uintptr_t)px; (void)gl64_trap(GL64_fn_glTexSubImage3D,&a); }
API void glCompressedTexImage3D(GLenum target, GLint level, GLenum ifmt, GLsizei w, GLsizei h, GLsizei d, GLsizei imageSize, const void* data){
    GL64Args a={{0}}; a.a[0]=target; a.a[1]=(uint64_t)(uint32_t)level; a.a[2]=ifmt; a.a[3]=(uint64_t)(uint32_t)w; a.a[4]=(uint64_t)(uint32_t)h;
    a.a[5]=(uint64_t)(uint32_t)d; a.a[6]=(uint64_t)(uint32_t)imageSize; a.a[7]=(uint64_t)(uintptr_t)data; (void)gl64_trap(GL64_fn_glCompressedTexImage3D,&a); }
API void glCompressedTexSubImage3D(GLenum target, GLint level, GLint x, GLint y, GLint z, GLsizei w, GLsizei h, GLsizei d, GLenum fmt, GLsizei imageSize, const void* data){
    GL64Args a={{0}}; a.a[0]=target; a.a[1]=(uint64_t)(uint32_t)level; a.a[2]=(uint64_t)(uint32_t)x; a.a[3]=(uint64_t)(uint32_t)y;
    a.a[4]=(uint64_t)(uint32_t)z; a.a[5]=(uint64_t)(uint32_t)w; a.a[6]=(uint64_t)(uint32_t)h; a.a[7]=(uint64_t)(uint32_t)d;
    a.a[8]=fmt; a.a[9]=(uint64_t)(uint32_t)imageSize; a.a[10]=(uint64_t)(uintptr_t)data; (void)gl64_trap(GL64_fn_glCompressedTexSubImage3D,&a); }
API void glTexImage3DEXT(GLenum t, GLint l, GLenum i, GLsizei w, GLsizei h, GLsizei d, GLint b, GLenum f, GLenum ty, const void* p){ glTexImage3D(t,l,i,w,h,d,b,f,ty,p); }
API void glCompressedTexImage3DARB(GLenum t, GLint l, GLenum i, GLsizei w, GLsizei h, GLsizei d, GLsizei s, const void* p){ glCompressedTexImage3D(t,l,i,w,h,d,s,p); }
API void glTexImage2DMultisample(GLenum t, GLsizei s, GLenum i, GLsizei w, GLsizei h, GLboolean fixed){
    GL64Args a={{0}}; a.a[0]=t; a.a[1]=(uint64_t)(uint32_t)s; a.a[2]=i; a.a[3]=(uint64_t)(uint32_t)w; a.a[4]=(uint64_t)(uint32_t)h; a.a[5]=fixed; (void)gl64_trap(GL64_fn_glTexImage2DMultisample,&a); }
API void glTexImage3DMultisample(GLenum t, GLsizei s, GLenum i, GLsizei w, GLsizei h, GLsizei d, GLboolean fixed){
    GL64Args a={{0}}; a.a[0]=t; a.a[1]=(uint64_t)(uint32_t)s; a.a[2]=i; a.a[3]=(uint64_t)(uint32_t)w; a.a[4]=(uint64_t)(uint32_t)h; a.a[5]=(uint64_t)(uint32_t)d; a.a[6]=fixed; (void)gl64_trap(GL64_fn_glTexImage3DMultisample,&a); }
// C7: immutable storage. Wine allocates depth/stencil probe textures via
// glTexStorage*; previously PROC MISS -> gl64_noop, so attachments referenced
// storage that never existed (and the calls were invisible in the trace).
API void glTexStorage2D(GLenum t, GLsizei levels, GLenum ifmt, GLsizei w, GLsizei h){
    GL64Args a={{0}}; a.a[0]=t; a.a[1]=(uint64_t)(uint32_t)levels; a.a[2]=ifmt; a.a[3]=(uint64_t)(uint32_t)w; a.a[4]=(uint64_t)(uint32_t)h; (void)gl64_trap(GL64_fn_glTexStorage2D,&a); }
API void glTexStorage3D(GLenum t, GLsizei levels, GLenum ifmt, GLsizei w, GLsizei h, GLsizei d){
    GL64Args a={{0}}; a.a[0]=t; a.a[1]=(uint64_t)(uint32_t)levels; a.a[2]=ifmt; a.a[3]=(uint64_t)(uint32_t)w; a.a[4]=(uint64_t)(uint32_t)h; a.a[5]=(uint64_t)(uint32_t)d; (void)gl64_trap(GL64_fn_glTexStorage3D,&a); }
API void glTexStorage1D(GLenum t, GLsizei levels, GLenum ifmt, GLsizei w){
    GL64Args a={{0}}; a.a[0]=t; a.a[1]=(uint64_t)(uint32_t)levels; a.a[2]=ifmt; a.a[3]=(uint64_t)(uint32_t)w; (void)gl64_trap(GL64_fn_glTexStorage1D,&a); }
// C10: multisample immutable storage (see ABI note). Same guest ABI shape as
// the TexImage*Multisample wrappers; the host backs them with the identical
// immutable multisample allocation.
API void glTexStorage2DMultisample(GLenum t, GLsizei samples, GLenum ifmt, GLsizei w, GLsizei h, GLboolean fixed){
    GL64Args a={{0}}; a.a[0]=t; a.a[1]=(uint64_t)(uint32_t)samples; a.a[2]=ifmt; a.a[3]=(uint64_t)(uint32_t)w; a.a[4]=(uint64_t)(uint32_t)h; a.a[5]=fixed; (void)gl64_trap(GL64_fn_glTexStorage2DMultisample,&a); }
API void glTexStorage3DMultisample(GLenum t, GLsizei samples, GLenum ifmt, GLsizei w, GLsizei h, GLsizei d, GLboolean fixed){
    GL64Args a={{0}}; a.a[0]=t; a.a[1]=(uint64_t)(uint32_t)samples; a.a[2]=ifmt; a.a[3]=(uint64_t)(uint32_t)w; a.a[4]=(uint64_t)(uint32_t)h; a.a[5]=(uint64_t)(uint32_t)d; a.a[6]=fixed; (void)gl64_trap(GL64_fn_glTexStorage3DMultisample,&a); }
API void glGetMultisamplefv(GLenum pname, GLuint index, GLfloat* values){
    GL64Args a={{0}}; a.a[0]=pname; a.a[1]=index; a.a[2]=(uint64_t)(uintptr_t)values; (void)gl64_trap(GL64_fn_glGetMultisamplefv,&a); }

// --- MRT / frag-data / uniform blocks / buffer objects ---
API void glBindFragDataLocation(GLuint p, GLuint color, const GLchar* name){ GL64Args a={{0}}; a.a[0]=p; a.a[1]=color; a.a[2]=(uint64_t)(uintptr_t)name; (void)gl64_trap(GL64_fn_glBindFragDataLocation,&a); }
API GLint glGetFragDataIndex(GLuint p, const GLchar* name){ GL64Args a={{0}}; a.a[0]=p; a.a[1]=(uint64_t)(uintptr_t)name; return (GLint)gl64_trap(GL64_fn_glGetFragDataIndex,&a); }
API void glBindBufferRange(GLenum t, GLuint idx, GLuint buf, GLintptr off, GLsizeiptr size){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=idx; a.a[2]=buf; a.a[3]=(uint64_t)off; a.a[4]=(uint64_t)size; (void)gl64_trap(GL64_fn_glBindBufferRange,&a); }
API void glBindBufferBase(GLenum t, GLuint idx, GLuint buf){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=idx; a.a[2]=buf; (void)gl64_trap(GL64_fn_glBindBufferBase,&a); }
API GLuint glGetUniformBlockIndex(GLuint p, const GLchar* name){ GL64Args a={{0}}; a.a[0]=p; a.a[1]=(uint64_t)(uintptr_t)name; return (GLuint)gl64_trap(GL64_fn_glGetUniformBlockIndex,&a); }
API void glUniformBlockBinding(GLuint p, GLuint idx, GLuint binding){ GL64Args a={{0}}; a.a[0]=p; a.a[1]=idx; a.a[2]=binding; (void)gl64_trap(GL64_fn_glUniformBlockBinding,&a); }
API void glGetActiveUniformBlockiv(GLuint p, GLuint idx, GLenum pname, GLint* params){ GL64Args a={{0}}; a.a[0]=p; a.a[1]=idx; a.a[2]=pname; a.a[3]=(uint64_t)(uintptr_t)params; (void)gl64_trap(GL64_fn_glGetActiveUniformBlockiv,&a); }
API void glGetActiveUniformBlockName(GLuint p, GLuint idx, GLsizei bufSize, GLsizei* len, GLchar* name){ GL64Args a={{0}}; a.a[0]=p; a.a[1]=idx; a.a[2]=(uint64_t)(uint32_t)bufSize; a.a[3]=(uint64_t)(uintptr_t)len; a.a[4]=(uint64_t)(uintptr_t)name; (void)gl64_trap(GL64_fn_glGetActiveUniformBlockName,&a); }
API void glBufferStorage(GLenum t, GLsizeiptr size, const void* data, GLbitfield flags){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=(uint64_t)size; a.a[2]=(uint64_t)(uintptr_t)data; a.a[3]=flags; (void)gl64_trap(GL64_fn_glBufferStorage,&a); }
API void glCopyBufferSubData(GLenum rt, GLenum wt, GLintptr ro, GLintptr wo, GLsizeiptr size){ GL64Args a={{0}}; a.a[0]=rt; a.a[1]=wt; a.a[2]=(uint64_t)ro; a.a[3]=(uint64_t)wo; a.a[4]=(uint64_t)size; (void)gl64_trap(GL64_fn_glCopyBufferSubData,&a); }
API void glGetBufferSubData(GLenum t, GLintptr off, GLsizeiptr size, void* data){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=(uint64_t)off; a.a[2]=(uint64_t)size; a.a[3]=(uint64_t)(uintptr_t)data; (void)gl64_trap(GL64_fn_glGetBufferSubData,&a); }
API void glGetBufferParameteriv(GLenum t, GLenum pname, GLint* params){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=pname; a.a[2]=(uint64_t)(uintptr_t)params; (void)gl64_trap(GL64_fn_glGetBufferParameteriv,&a); }

// --- int uniforms / introspection ---
API void glUniform2i(GLint l, GLint v0, GLint v1){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)l; a.a[1]=(uint64_t)(uint32_t)v0; a.a[2]=(uint64_t)(uint32_t)v1; (void)gl64_trap(GL64_fn_glUniform2i,&a); }
API void glUniform3i(GLint l, GLint v0, GLint v1, GLint v2){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)l; a.a[1]=(uint64_t)(uint32_t)v0; a.a[2]=(uint64_t)(uint32_t)v1; a.a[3]=(uint64_t)(uint32_t)v2; (void)gl64_trap(GL64_fn_glUniform3i,&a); }
API void glUniform4i(GLint l, GLint v0, GLint v1, GLint v2, GLint v3){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)l; a.a[1]=(uint64_t)(uint32_t)v0; a.a[2]=(uint64_t)(uint32_t)v1; a.a[3]=(uint64_t)(uint32_t)v2; a.a[4]=(uint64_t)(uint32_t)v3; (void)gl64_trap(GL64_fn_glUniform4i,&a); }
API void glUniform2iv(GLint l, GLsizei n, const GLint* v){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)l; a.a[1]=(uint64_t)(uint32_t)n; a.a[2]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glUniform2iv,&a); }
API void glUniform3iv(GLint l, GLsizei n, const GLint* v){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)l; a.a[1]=(uint64_t)(uint32_t)n; a.a[2]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glUniform3iv,&a); }
API void glUniform4iv(GLint l, GLsizei n, const GLint* v){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uint32_t)l; a.a[1]=(uint64_t)(uint32_t)n; a.a[2]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glUniform4iv,&a); }
API void glGetUniformfv(GLuint p, const GLint* locs, GLfloat* vals){ GL64Args a={{0}}; a.a[0]=p; a.a[1]=(uint64_t)(uintptr_t)locs; a.a[2]=(uint64_t)(uintptr_t)vals; (void)gl64_trap(GL64_fn_glGetUniformfv,&a); }
API void glGetUniformiv(GLuint p, const GLint* locs, GLint* vals){ GL64Args a={{0}}; a.a[0]=p; a.a[1]=(uint64_t)(uintptr_t)locs; a.a[2]=(uint64_t)(uintptr_t)vals; (void)gl64_trap(GL64_fn_glGetUniformiv,&a); }
API void glGetActiveUniform(GLuint p, GLuint index, GLsizei bufSize, GLsizei* len, GLchar* name){ GL64Args a={{0}}; a.a[0]=p; a.a[1]=index; a.a[2]=(uint64_t)(uint32_t)bufSize; a.a[3]=(uint64_t)(uintptr_t)len; a.a[4]=(uint64_t)(uintptr_t)name; (void)gl64_trap(GL64_fn_glGetActiveUniform,&a); }
API void glGetAttachedShaders(GLuint p, GLsizei maxCount, GLsizei* count, GLuint* shaders){ GL64Args a={{0}}; a.a[0]=p; a.a[1]=(uint64_t)(uint32_t)maxCount; a.a[2]=(uint64_t)(uintptr_t)count; a.a[3]=(uint64_t)(uintptr_t)shaders; (void)gl64_trap(GL64_fn_glGetAttachedShaders,&a); }
// NB: wined3d resolves the plain "glGetShaderSource" spelling; the host fn id is
// GL64_fn_glGetShaderSourceImpl so it does not collide with the (unimplemented)
// GL64_fn_glGetShaderSource from the original ABI.
API void glGetShaderSource(GLuint sh, GLsizei bufSize, GLsizei* len, GLchar* src){ GL64Args a={{0}}; a.a[0]=sh; a.a[1]=(uint64_t)(uint32_t)bufSize; a.a[2]=(uint64_t)(uintptr_t)len; a.a[3]=(uint64_t)(uintptr_t)src; (void)gl64_trap(GL64_fn_glGetShaderSourceImpl,&a); }
API void glGetTexParameteriv(GLenum t, GLenum pname, GLint* params){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=pname; a.a[2]=(uint64_t)(uintptr_t)params; (void)gl64_trap(GL64_fn_glGetTexParameteriv,&a); }
API void glGetTexLevelParameteriv(GLenum t, GLint level, GLenum pname, GLint* params){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=(uint64_t)(uint32_t)level; a.a[2]=pname; a.a[3]=(uint64_t)(uintptr_t)params; (void)gl64_trap(GL64_fn_glGetTexLevelParameteriv,&a); }
API void glGetTextureParameteriv(GLuint tex, GLenum pname, GLint* params){ GL64Args a={{0}}; a.a[0]=tex; a.a[1]=pname; a.a[2]=(uint64_t)(uintptr_t)params; (void)gl64_trap(GL64_fn_glGetTextureParameteriv,&a); }
API void glGetTextureLevelParameteriv(GLuint tex, GLint level, GLenum pname, GLint* params){ GL64Args a={{0}}; a.a[0]=tex; a.a[1]=(uint64_t)(uint32_t)level; a.a[2]=pname; a.a[3]=(uint64_t)(uintptr_t)params; (void)gl64_trap(GL64_fn_glGetTextureLevelParameteriv,&a); }
API void glGetCompressedTexImage(GLenum t, GLint level, void* img){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=(uint64_t)(uint32_t)level; a.a[2]=(uint64_t)(uintptr_t)img; (void)gl64_trap(GL64_fn_glGetCompressedTexImage,&a); }
API void glCompressedTexSubImage2D(GLenum t, GLint l, GLint x, GLint y, GLsizei w, GLsizei h, GLenum f, GLsizei s, const void* d){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=(uint64_t)(uint32_t)l; a.a[2]=(uint64_t)(uint32_t)x; a.a[3]=(uint64_t)(uint32_t)y; a.a[4]=(uint64_t)(uint32_t)w; a.a[5]=(uint64_t)(uint32_t)h; a.a[6]=f; a.a[7]=(uint64_t)(uint32_t)s; a.a[8]=(uint64_t)(uintptr_t)d; (void)gl64_trap(GL64_fn_glCompressedTexSubImage2D,&a); }

// --- indexed state (GL 3.0 core / ARB_blend_func_extended) ---
API void glEnablei(GLuint i, GLenum cap){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=cap; (void)gl64_trap(GL64_fn_glEnablei,&a); }
API void glDisablei(GLuint i, GLenum cap){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=cap; (void)gl64_trap(GL64_fn_glDisablei,&a); }
API GLboolean glIsEnabledi(GLuint i, GLenum cap){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=cap; return (GLboolean)gl64_trap(GL64_fn_glIsEnabledi,&a); }
API void glBlendEquationi(GLuint buf, GLenum mode){ GL64Args a={{0}}; a.a[0]=buf; a.a[1]=mode; (void)gl64_trap(GL64_fn_glBlendEquationi,&a); }
API void glBlendEquationSeparatei(GLuint buf, GLenum rgb, GLenum alpha){ GL64Args a={{0}}; a.a[0]=buf; a.a[1]=rgb; a.a[2]=alpha; (void)gl64_trap(GL64_fn_glBlendEquationSeparatei,&a); }
API void glBlendFunci(GLuint buf, GLenum s, GLenum d){ GL64Args a={{0}}; a.a[0]=buf; a.a[1]=s; a.a[2]=d; (void)gl64_trap(GL64_fn_glBlendFunci,&a); }
API void glBlendFuncSeparatei(GLuint buf, GLenum sr, GLenum dr, GLenum sa, GLenum da){ GL64Args a={{0}}; a.a[0]=buf; a.a[1]=sr; a.a[2]=dr; a.a[3]=sa; a.a[4]=da; (void)gl64_trap(GL64_fn_glBlendFuncSeparatei,&a); }
API void glColorMaski(GLuint buf, GLboolean r, GLboolean g, GLboolean b, GLboolean al){ GL64Args a={{0}}; a.a[0]=buf; a.a[1]=r; a.a[2]=g; a.a[3]=b; a.a[4]=al; (void)gl64_trap(GL64_fn_glColorMaski,&a); }
API void glMinSampleShading(GLfloat v){ GL64Args a={{0}}; a.a[0]=F2U(v); (void)gl64_trap(GL64_fn_glMinSampleShading,&a); }

// --- instancing / base vertex ---
API void glVertexAttribDivisor(GLuint i, GLuint d){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=d; (void)gl64_trap(GL64_fn_glVertexAttribDivisor,&a); }
API void glVertexAttribDivisorARB(GLuint i, GLuint d){ glVertexAttribDivisor(i, d); }
API void glDrawArraysInstanced(GLenum m, GLint first, GLsizei count, GLsizei prim){ GL64Args a={{0}}; a.a[0]=m; a.a[1]=(uint64_t)(uint32_t)first; a.a[2]=(uint64_t)(uint32_t)count; a.a[3]=(uint64_t)(uint32_t)prim; (void)gl64_trap(GL64_fn_glDrawArraysInstanced,&a); }
API void glDrawElementsInstanced(GLenum m, GLsizei count, GLenum type, const void* idx, GLsizei prim){ GL64Args a={{0}}; a.a[0]=m; a.a[1]=(uint64_t)(uint32_t)count; a.a[2]=type; a.a[3]=(uint64_t)(uintptr_t)idx; a.a[4]=(uint64_t)(uint32_t)prim; (void)gl64_trap(GL64_fn_glDrawElementsInstanced,&a); }
API void glDrawArraysInstancedARB(GLenum m, GLint first, GLsizei count, GLsizei prim){ glDrawArraysInstanced(m, first, count, prim); }
API void glDrawElementsInstancedARB(GLenum m, GLsizei count, GLenum type, const void* idx, GLsizei prim){ glDrawElementsInstanced(m, count, type, idx, prim); }
API void glDrawArraysInstancedBaseInstance(GLenum m, GLint f, GLsizei c, GLsizei p, GLuint bi){ GL64Args a={{0}}; a.a[0]=m; a.a[1]=(uint64_t)(uint32_t)f; a.a[2]=(uint64_t)(uint32_t)c; a.a[3]=(uint64_t)(uint32_t)p; a.a[4]=bi; (void)gl64_trap(GL64_fn_glDrawArraysInstancedBaseInstance,&a); }
API void glDrawElementsInstancedBaseVertexBaseInstance(GLenum m, GLsizei c, GLenum type, const void* idx, GLsizei p, GLint bv, GLuint bi){ GL64Args a={{0}}; a.a[0]=m; a.a[1]=(uint64_t)(uint32_t)c; a.a[2]=type; a.a[3]=(uint64_t)(uintptr_t)idx; a.a[4]=(uint64_t)(uint32_t)p; a.a[5]=(uint64_t)(uint32_t)bv; a.a[6]=bi; (void)gl64_trap(GL64_fn_glDrawElementsInstancedBaseVertexBaseInstance,&a); }
API void glDrawElementsBaseVertex(GLenum m, GLsizei c, GLenum type, const void* idx, GLint bv){ GL64Args a={{0}}; a.a[0]=m; a.a[1]=(uint64_t)(uint32_t)c; a.a[2]=type; a.a[3]=(uint64_t)(uintptr_t)idx; a.a[4]=(uint64_t)(uint32_t)bv; (void)gl64_trap(GL64_fn_glDrawElementsBaseVertex,&a); }
API void glDrawRangeElementsBaseVertex(GLenum m, GLuint s, GLuint e, GLsizei c, GLenum type, const void* idx, GLint bv){ GL64Args a={{0}}; a.a[0]=m; a.a[1]=s; a.a[2]=e; a.a[3]=(uint64_t)(uint32_t)c; a.a[4]=type; a.a[5]=(uint64_t)(uintptr_t)idx; a.a[6]=(uint64_t)(uint32_t)bv; (void)gl64_trap(GL64_fn_glDrawRangeElementsBaseVertex,&a); }
API void glMultiDrawArrays(GLenum m, const GLint* first, const GLsizei* count, GLsizei n){
    if (!first || !count || n <= 0) return;
    for (GLsizei i = 0; i < n; i++) glDrawArrays(m, first[i], count[i]); }
API void glMultiDrawElements(GLenum m, const GLsizei* count, GLenum type, const void* const* idx, GLsizei n){
    if (!count || !idx || n <= 0) return;
    for (GLsizei i = 0; i < n; i++) glDrawElements(m, count[i], type, idx[i]); }

// --- misc / best-effort ---
typedef void (*GLdebugproc)(GLenum, GLenum, GLuint, GLenum, GLsizei, const GLchar*, const void*);
API void glDebugMessageCallback(GLdebugproc cb, const void* user){ GL64Args a={{0}}; a.a[0]=(uint64_t)(uintptr_t)cb; a.a[1]=(uint64_t)(uintptr_t)user; (void)gl64_trap(GL64_fn_glDebugMessageCallback,&a); }
API void glDebugMessageControl(GLenum src, GLenum type, GLuint id, GLenum sev, GLsizei n, const GLuint* en, GLboolean enabled){
    GL64Args a={{0}}; a.a[0]=src; a.a[1]=type; a.a[2]=id; a.a[3]=sev; a.a[4]=(uint64_t)(uint32_t)n; a.a[5]=(uint64_t)(uintptr_t)en; a.a[6]=enabled; (void)gl64_trap(GL64_fn_glDebugMessageControl,&a); }
API void glDebugMessageInsert(GLenum src, GLenum type, GLuint id, GLenum sev, GLsizei len, const GLchar* buf){ GL64Args a={{0}}; a.a[0]=src; a.a[1]=type; a.a[2]=id; a.a[3]=sev; a.a[4]=(uint64_t)(uint32_t)len; a.a[5]=(uint64_t)(uintptr_t)buf; (void)gl64_trap(GL64_fn_glDebugMessageInsert,&a); }
API GLuint glGetDebugMessageLog(GLuint count, GLenum* sources, GLenum* types, GLuint* ids, GLenum* sevs, GLsizei* lens, GLchar* log){
    GL64Args a={{0}}; a.a[0]=count; a.a[1]=(uint64_t)(uintptr_t)sources; a.a[2]=(uint64_t)(uintptr_t)types; a.a[3]=(uint64_t)(uintptr_t)ids; a.a[4]=(uint64_t)(uintptr_t)sevs; a.a[5]=(uint64_t)(uintptr_t)lens; a.a[6]=(uint64_t)(uintptr_t)log;
    (void)gl64_trap(GL64_fn_glGetDebugMessageLog,&a); return 0; }
API void glBeginTransformFeedback(GLenum mode){ GL64Args a={{0}}; a.a[0]=mode; (void)gl64_trap(GL64_fn_glBeginTransformFeedback,&a); }
API void glEndTransformFeedback(void){ (void)gl64_trap(GL64_fn_glEndTransformFeedback,0); }
API void glTransformFeedbackVaryings(GLuint p, GLsizei n, const GLchar* const* vars, GLenum mode){ GL64Args a={{0}}; a.a[0]=p; a.a[1]=(uint64_t)(uint32_t)n; a.a[2]=(uint64_t)(uintptr_t)vars; a.a[3]=mode; (void)gl64_trap(GL64_fn_glTransformFeedbackVaryings,&a); }
API void glPointParameteri(GLenum pname, GLint param){ GL64Args a={{0}}; a.a[0]=pname; a.a[1]=(uint64_t)(uint32_t)param; (void)gl64_trap(GL64_fn_glPointParameteri,&a); }
API void glPointParameteriv(GLenum pname, const GLint* params){ GL64Args a={{0}}; a.a[0]=pname; a.a[1]=(uint64_t)(uintptr_t)params; (void)gl64_trap(GL64_fn_glPointParameteriv,&a); }
API void glPointParameterf(GLenum pname, GLfloat param){ GL64Args a={{0}}; a.a[0]=pname; a.a[1]=F2U(param); (void)gl64_trap(GL64_fn_glPointParameterf,&a); }
API void glPointParameterfv(GLenum pname, const GLfloat* params){ GL64Args a={{0}}; a.a[0]=pname; a.a[1]=(uint64_t)(uintptr_t)params; (void)gl64_trap(GL64_fn_glPointParameterfv,&a); }
API void glTexBuffer(GLenum t, GLenum i, GLuint b){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=i; a.a[2]=b; (void)gl64_trap(GL64_fn_glTexBuffer,&a); }
API void glTexBufferRange(GLenum t, GLenum i, GLuint b, GLintptr off, GLsizeiptr size){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=i; a.a[2]=b; a.a[3]=(uint64_t)off; a.a[4]=(uint64_t)size; (void)gl64_trap(GL64_fn_glTexBufferRange,&a); }
API void glTexBufferARB(GLenum t, GLenum i, GLuint b){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=i; a.a[2]=b; (void)gl64_trap(GL64_fn_glTexBufferARB,&a); }
API void glTexBufferRangeARB(GLenum t, GLenum i, GLuint b, GLintptr off, GLsizeiptr size){ GL64Args a={{0}}; a.a[0]=t; a.a[1]=i; a.a[2]=b; a.a[3]=(uint64_t)off; a.a[4]=(uint64_t)size; (void)gl64_trap(GL64_fn_glTexBufferRangeARB,&a); }
API void glTextureBarrierNV(void){ (void)gl64_trap(GL64_fn_glTextureBarrierNV,0); }
API void glFinalCombinerInputNV(GLenum target, GLenum input, GLenum inputName){ GL64Args a={{0}}; a.a[0]=target; a.a[1]=input; a.a[2]=inputName; (void)gl64_trap(GL64_fn_glFinalCombinerInputNV,&a); }
API void glVertexAttrib1f(GLuint i, GLfloat v0){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=F2U(v0); (void)gl64_trap(GL64_fn_glVertexAttrib1f,&a); }
API void glVertexAttrib2f(GLuint i, GLfloat x, GLfloat y){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=F2U(x); a.a[2]=F2U(y); (void)gl64_trap(GL64_fn_glVertexAttrib2f,&a); }
API void glVertexAttrib3f(GLuint i, GLfloat x, GLfloat y, GLfloat z){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=F2U(x); a.a[2]=F2U(y); a.a[3]=F2U(z); (void)gl64_trap(GL64_fn_glVertexAttrib3f,&a); }
API void glVertexAttrib1fv(GLuint i, const GLfloat* v){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glVertexAttrib1fv,&a); }
API void glVertexAttrib2fv(GLuint i, const GLfloat* v){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glVertexAttrib2fv,&a); }
API void glVertexAttrib3fv(GLuint i, const GLfloat* v){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glVertexAttrib3fv,&a); }
API void glVertexAttrib4fv(GLuint i, const GLfloat* v){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glVertexAttrib4fv,&a); }
API void glVertexAttrib1d(GLuint i, GLdouble v0){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=D2U(v0); (void)gl64_trap(GL64_fn_glVertexAttrib1d,&a); }
API void glVertexAttrib2d(GLuint i, GLdouble v0, GLdouble v1){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=D2U(v0); a.a[2]=D2U(v1); (void)gl64_trap(GL64_fn_glVertexAttrib2d,&a); }
API void glVertexAttrib3d(GLuint i, GLdouble v0, GLdouble v1, GLdouble v2){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=D2U(v0); a.a[2]=D2U(v1); a.a[3]=D2U(v2); (void)gl64_trap(GL64_fn_glVertexAttrib3d,&a); }
API void glVertexAttrib4d(GLuint i, GLdouble v0, GLdouble v1, GLdouble v2, GLdouble v3){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=D2U(v0); a.a[2]=D2U(v1); a.a[3]=D2U(v2); a.a[4]=D2U(v3); (void)gl64_trap(GL64_fn_glVertexAttrib4d,&a); }
API void glVertexAttrib1dv(GLuint i, const GLdouble* v){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glVertexAttrib1dv,&a); }
API void glVertexAttrib2dv(GLuint i, const GLdouble* v){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glVertexAttrib2dv,&a); }
API void glVertexAttrib3dv(GLuint i, const GLdouble* v){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glVertexAttrib3dv,&a); }
API void glVertexAttrib4dv(GLuint i, const GLdouble* v){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glVertexAttrib4dv,&a); }
API void glVertexAttribI4i(GLuint i, GLint x, GLint y, GLint z, GLint w){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=(uint64_t)(uint32_t)x; a.a[2]=(uint64_t)(uint32_t)y; a.a[3]=(uint64_t)(uint32_t)z; a.a[4]=(uint64_t)(uint32_t)w; (void)gl64_trap(GL64_fn_glVertexAttribI4i,&a); }
API void glVertexAttribI4ui(GLuint i, GLuint x, GLuint y, GLuint z, GLuint w){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=x; a.a[2]=y; a.a[3]=z; a.a[4]=w; (void)gl64_trap(GL64_fn_glVertexAttribI4ui,&a); }
API void glVertexAttribI4iv(GLuint i, const GLint* v){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glVertexAttribI4iv,&a); }
API void glVertexAttribI4uiv(GLuint i, const GLuint* v){ GL64Args a={{0}}; a.a[0]=i; a.a[1]=(uint64_t)(uintptr_t)v; (void)gl64_trap(GL64_fn_glVertexAttribI4uiv,&a); }

// --- A2 cycle 2 -----------------------------------------------------------------
// glPolygonOffsetClamp is one of three feature_level_from_caps() gates for every
// feature level >= 10_0 (adapter_gl.c: WINED3D_GL_VERSION_3_2 && ARB_POLYGON_OFFSET_CLAMP
// && ARB_SAMPLER_OBJECTS). WebGL2 has no polygonOffsetClamp, so the host forwards
// factor/units to glPolygonOffset and drops the clamp — a depth bias without the
// clamp is visually identical over the range a float depth buffer can hold, and NOT
// advertising it pins the D3D11 device at FL 9_3 no matter what else is real.
API void glPolygonOffsetClamp(GLfloat factor, GLfloat units, GLfloat clamp){
    GL64Args a={{0}}; a.a[0]=F2U(factor); a.a[1]=F2U(units); a.a[2]=F2U(clamp);
    (void)gl64_trap(GL64_fn_glPolygonOffsetClamp,&a); }
API void glDrawElementsInstancedBaseVertex(GLenum m, GLsizei c, GLenum type, const void* idx, GLsizei prim, GLint bv){
    GL64Args a={{0}}; a.a[0]=m; a.a[1]=(uint64_t)(uint32_t)c; a.a[2]=type; a.a[3]=(uint64_t)(uintptr_t)idx; a.a[4]=(uint64_t)(uint32_t)prim; a.a[5]=(uint64_t)(uint32_t)bv;
    (void)gl64_trap(GL64_fn_glDrawElementsInstancedBaseVertex,&a); }
API void glMultiDrawElementsBaseVertex(GLenum m, const GLsizei* count, GLenum type, const void* const* idx, GLsizei prim, const GLint* bv){
    GL64Args a={{0}}; a.a[0]=m; a.a[1]=(uint64_t)(uintptr_t)count; a.a[2]=type; a.a[3]=(uint64_t)(uintptr_t)idx; a.a[4]=(uint64_t)(uint32_t)prim; a.a[5]=(uint64_t)(uintptr_t)bv;
    (void)gl64_trap(GL64_fn_glMultiDrawElementsBaseVertex,&a); }
API void glTextureBarrier(void){ (void)gl64_trap(GL64_fn_glTextureBarrier,0); }

// ===========================================================================
// glXGetProcAddressARB — opengl32/winex11 resolve every gl*/glX* through here.
// Return our own wrapper for names we implement, or a harmless no-op stub for
// the rest (so an unimplemented call is silently ignored rather than crashing).
// ===========================================================================
typedef void (*GLproc)(void);

static void gl64_noop(void) { /* unimplemented GL entry — ignore for first light */ }

struct procEntry { const char* name; GLproc fn; };
#define E(n) { #n, (GLproc)n }
static const struct procEntry g_procs[] = {
    E(glXQueryVersion), E(glXQueryExtension), E(glXQueryExtensionsString),
    E(glXQueryServerString), E(glXGetClientString), E(glXChooseVisual),
    E(glXCreateContext), E(glXCreateContextAttribsARB), E(glXCreateNewContext),
    E(glXChooseFBConfig), E(glXGetFBConfigs), E(glXGetFBConfigAttrib),
    E(glXGetVisualFromFBConfig), E(glXGetConfig), E(glXMakeCurrent),
    E(glXMakeContextCurrent), E(glXSwapBuffers), E(glXDestroyContext),
    E(glXIsDirect), E(glXGetCurrentContext), E(glXGetCurrentDrawable),
    E(glXWaitGL), E(glXWaitX), E(glXSwapIntervalEXT), E(glXSwapIntervalMESA),
    E(glXSwapIntervalSGI),
    E(glClearColor), E(glClear), E(glClearDepth), E(glViewport), E(glEnable),
    E(glDisable), E(glShadeModel), E(glDepthFunc), E(glCullFace), E(glFrontFace),
    E(glHint), E(glFlush), E(glFinish), E(glGetError), E(glGetString),
    E(glGetIntegerv), E(glGetFloatv), E(glColor3f), E(glColor4f),
    E(glMatrixMode), E(glLoadIdentity), E(glPushMatrix), E(glPopMatrix),
    E(glFrustum), E(glOrtho), E(glTranslatef), E(glRotatef), E(glScalef),
    E(glMultMatrixf), E(glLightfv), E(glLightf), E(glMaterialfv), E(glMaterialf),
    E(glColorMaterial), E(glNormal3f), E(glBegin), E(glEnd), E(glVertex2f),
    E(glVertex3f),
    // --- programmable pipeline (wined3d / Direct3D) ---
    E(glCreateShader), E(glShaderSource), E(glCompileShader), E(glGetShaderiv),
    E(glGetShaderInfoLog), E(glDeleteShader), E(glCreateProgram), E(glAttachShader),
    E(glDetachShader), E(glBindAttribLocation), E(glLinkProgram), E(glGetProgramiv),
    E(glGetProgramInfoLog), E(glUseProgram), E(glDeleteProgram), E(glGetUniformLocation),
    E(glGetAttribLocation), E(glValidateProgram),
    E(glUniform1i), E(glUniform1f), E(glUniform2f), E(glUniform3f), E(glUniform4f),
    E(glUniform1fv), E(glUniform2fv), E(glUniform3fv), E(glUniform4fv), E(glUniform1iv),
    E(glUniformMatrix2fv), E(glUniformMatrix3fv), E(glUniformMatrix4fv),
    E(glGenBuffers), E(glBindBuffer), E(glBufferData), E(glBufferSubData),
    E(glDeleteBuffers), E(glMapBufferRange),
    E(glMapBuffer), E(glUnmapBuffer), E(glFlushMappedBufferRange),
    E(glGenBuffersARB), E(glBindBufferARB), E(glBufferDataARB), E(glBufferSubDataARB),
    E(glDeleteBuffersARB), E(glMapBufferARB), E(glUnmapBufferARB),
    E(glEnableVertexAttribArray), E(glDisableVertexAttribArray), E(glVertexAttribPointer),
    E(glGenVertexArrays), E(glBindVertexArray), E(glDeleteVertexArrays), E(glVertexAttrib4f),
    E(glDrawArrays), E(glDrawElements), E(glDrawRangeElements),
    E(glBlendFunc), E(glBlendFuncSeparate), E(glBlendEquation), E(glBlendEquationSeparate),
    E(glBlendColor), E(glColorMask), E(glDepthMask),
    E(glStencilFunc), E(glStencilOp), E(glStencilMask),
    E(glStencilFuncSeparate), E(glStencilOpSeparate), E(glStencilMaskSeparate),
    E(glScissor), E(glPolygonOffset), E(glPolygonMode), E(glDepthRange),
    E(glLineWidth), E(glPixelStorei), E(glSampleCoverage),
    E(glActiveTexture), E(glGenTextures), E(glBindTexture), E(glDeleteTextures),
    E(glTexParameteri), E(glTexParameterf), E(glTexImage1D), E(glTexImage2D), E(glTexSubImage2D),
    E(glGenerateMipmap), E(glCompressedTexImage2D), E(glGetStringi), E(glReadPixels), E(glGetTexImage),
    // --- ARB_sync + queries (wined3d Present/flush + occlusion) ---
    E(glFenceSync), E(glClientWaitSync), E(glWaitSync), E(glDeleteSync),
    E(glIsSync), E(glGetSynciv),
    E(glGenQueries), E(glDeleteQueries), E(glIsQuery), E(glBeginQuery),
    E(glEndQuery), E(glQueryCounter), E(glGetQueryiv), E(glGetQueryObjectiv),
    E(glGetQueryObjectuiv), E(glGetQueryObjectui64v),
    // --- A2: the GL 3.x surface (FBO / samplers / 3D tex / MRT / UBO / ...) ---
    // wined3d's load_gl_funcs binds these unconditionally; each used to fall
    // through to gl64_noop and be silently dropped.
    E(glGenFramebuffers), E(glDeleteFramebuffers), E(glBindFramebuffer),
    E(glIsFramebuffer), E(glFramebufferTexture1D), E(glFramebufferTexture2D),
    E(glFramebufferTexture3D), E(glFramebufferTexture), E(glFramebufferTextureLayer),
    E(glFramebufferRenderbuffer), E(glCheckFramebufferStatus), E(glBlitFramebuffer),
    E(glGenRenderbuffers), E(glDeleteRenderbuffers), E(glBindRenderbuffer),
    E(glRenderbufferStorage), E(glRenderbufferStorageMultisample), E(glIsRenderbuffer),
    E(glGetRenderbufferParameteriv), E(glGetFramebufferAttachmentParameteriv),
    E(glDrawBuffers), E(glReadBuffer),
    // ARB/EXT framebuffer aliases (wined3d's EXT fbo_ops fallback table)
    E(glGenFramebuffersEXT), E(glDeleteFramebuffersEXT), E(glBindFramebufferEXT),
    E(glIsFramebufferEXT), E(glFramebufferTexture1DEXT), E(glFramebufferTexture2DEXT),
    E(glFramebufferTexture3DEXT), E(glFramebufferRenderbufferEXT),
    E(glCheckFramebufferStatusEXT), E(glBlitFramebufferEXT),
    E(glGetFramebufferAttachmentParameterivEXT), E(glGenRenderbuffersEXT),
    E(glDeleteRenderbuffersEXT), E(glBindRenderbufferEXT), E(glRenderbufferStorageEXT),
    E(glRenderbufferStorageMultisampleEXT), E(glIsRenderbufferEXT),
    E(glGetRenderbufferParameterivEXT), E(glFramebufferTextureARB),
    E(glFramebufferTextureLayerARB), E(glFramebufferTexture2DARB),
    E(glFramebufferRenderbufferARB),
    E(glGenSamplers), E(glDeleteSamplers), E(glBindSampler), E(glIsSampler),
    E(glSamplerParameteri), E(glSamplerParameterf), E(glSamplerParameteriv),
    E(glSamplerParameterfv), E(glSamplerParameterIiv), E(glSamplerParameterIuiv),
    E(glGetSamplerParameteriv), E(glGetSamplerParameterfv),
    E(glGetSamplerParameterIiv), E(glGetSamplerParameterIuiv),
    E(glTexImage3D), E(glTexSubImage3D), E(glCompressedTexImage3D),
    E(glCompressedTexSubImage3D), E(glTexImage3DEXT), E(glCompressedTexImage3DARB),
    E(glTexImage2DMultisample), E(glTexImage3DMultisample),
    E(glTexStorage2D), E(glTexStorage3D), E(glTexStorage1D),
    E(glTexStorage2DMultisample), E(glTexStorage3DMultisample), E(glGetMultisamplefv),
    E(glBindFragDataLocation), E(glGetFragDataIndex), E(glBindBufferRange),
    E(glBindBufferBase), E(glGetUniformBlockIndex), E(glUniformBlockBinding),
    E(glGetActiveUniformBlockiv), E(glGetActiveUniformBlockName), E(glBufferStorage),
    E(glCopyBufferSubData), E(glGetBufferSubData), E(glGetBufferParameteriv),
    E(glUniform2i), E(glUniform3i), E(glUniform4i), E(glUniform2iv), E(glUniform3iv),
    E(glUniform4iv), E(glGetUniformfv), E(glGetUniformiv), E(glGetActiveUniform),
    E(glGetAttachedShaders), E(glGetShaderSource), E(glGetTexParameteriv),
    E(glGetTexLevelParameteriv), E(glGetTextureParameteriv),
    E(glGetTextureLevelParameteriv), E(glGetCompressedTexImage),
    E(glCompressedTexSubImage2D),
    E(glEnablei), E(glDisablei), E(glIsEnabledi), E(glBlendEquationi),
    E(glBlendEquationSeparatei), E(glBlendFunci), E(glBlendFuncSeparatei),
    E(glColorMaski), E(glMinSampleShading),
    E(glVertexAttribDivisor), E(glVertexAttribDivisorARB), E(glDrawArraysInstanced),
    E(glDrawElementsInstanced), E(glDrawArraysInstancedARB),
    E(glDrawElementsInstancedARB), E(glDrawArraysInstancedBaseInstance),
    E(glDrawElementsInstancedBaseVertexBaseInstance), E(glDrawElementsBaseVertex),
    E(glDrawRangeElementsBaseVertex), E(glMultiDrawArrays), E(glMultiDrawElements),
    E(glDebugMessageCallback), E(glDebugMessageControl), E(glDebugMessageInsert),
    E(glGetDebugMessageLog), E(glBeginTransformFeedback), E(glEndTransformFeedback),
    E(glTransformFeedbackVaryings), E(glPointParameteri), E(glPointParameteriv),
    E(glPointParameterf), E(glPointParameterfv), E(glTexBuffer), E(glTexBufferRange),
    E(glTexBufferARB), E(glTexBufferRangeARB), E(glTextureBarrierNV),
    E(glFinalCombinerInputNV), E(glVertexAttrib1f), E(glVertexAttrib2f),
    E(glVertexAttrib3f), E(glVertexAttrib1fv), E(glVertexAttrib2fv),
    E(glVertexAttrib3fv), E(glVertexAttrib4fv), E(glVertexAttrib1d),
    E(glVertexAttrib2d), E(glVertexAttrib3d), E(glVertexAttrib4d),
    E(glVertexAttrib1dv), E(glVertexAttrib2dv), E(glVertexAttrib3dv),
    E(glVertexAttrib4dv), E(glVertexAttribI4i), E(glVertexAttribI4ui),
E(glVertexAttribI4iv), E(glVertexAttribI4uiv),
// --- A2 cycle 2 ---
E(glPolygonOffsetClamp), E(glDrawElementsInstancedBaseVertex),
E(glMultiDrawElementsBaseVertex), E(glTextureBarrier),
};
#undef E
#define NPROCS (sizeof(g_procs)/sizeof(g_procs[0]))

API GLproc glXGetProcAddressARB(const GLubyte* name) {
    if (!name) return 0;
    for (unsigned i = 0; i < NPROCS; i++) {
        if (strcmp(g_procs[i].name, (const char*)name) == 0) {
            // hit=1: a real wrapper. Trace so BW64_GLTRACE shows wined3d's
            // resolved-and-implemented set.
            GL64Args a = {{0}}; a.a[0] = (uint64_t)(uintptr_t)name; a.a[1] = 1;
            (void)gl64_trap(GL64_fn_traceProc, &a);
            return g_procs[i].fn;
        }
    }
    // Unknown gl* function: trace it (hit=0) so the host log names exactly which
    // modern-GL entry point wined3d wanted that we don't implement yet — the
    // worklist for D3D. Then hand back a no-op so opengl32's dispatch fills its
    // table with a callable pointer (returning 0 would make wine think the
    // driver is broken and disable OpenGL).
    GL64Args a = {{0}}; a.a[0] = (uint64_t)(uintptr_t)name; a.a[1] = 0;
    (void)gl64_trap(GL64_fn_traceProc, &a);
    return gl64_noop;
}
API GLproc glXGetProcAddress(const GLubyte* name) { return glXGetProcAddressARB(name); }

// Full ALL_WGL_FUNCS coverage so wine's init_opengl dlsym loop succeeds.
#include "libgl64_stubs.h"
