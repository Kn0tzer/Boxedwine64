/*
 *  Copyright (C) 2012-2025  The BoxedWine Team
 *
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 */

// Shared ABI between the 64-bit guest libGL.so.1 (tools/rootfs64/libgl64) and
// the host marshaller (source/opengl/gl64bridge.cpp). This file is the single
// source of truth for:
//   - the private syscall number used to trap from guest to host
//   - the fixed-layout argument block passed across the trap
//   - the function-id enum identifying which GL/GLX entry point is being called
//
// It is plain C (compiles into both the host C++ tree and the guest C library),
// uses only fixed-width integers, and must stay self-contained (no other
// includes) so the guest build needs nothing from the host tree.
//
// Trap ABI (x86-64 Linux `syscall`):
//   RAX = GL64_SYSCALL_NR
//   RDI = function id (one of GL64_fn_*)
//   RSI = guest virtual address of a `struct GL64Args`
//   -> kernel returns the call's result (or 0 for void) in RAX
//
// Argument marshalling is uniform: every wrapper writes its scalar arguments
// into args.a[0..N-1] and traps. Conventions per slot:
//   - integer / enum / boolean args  : zero/sign-extended into the u64 slot
//   - 32-bit float (GLfloat)         : bit-cast to u32, stored in the low half
//   - 64-bit double (GLdouble)       : bit-cast to u64
//   - pointer args (guest buffers)   : the GUEST virtual address, as u64
// The host knows each function's signature from its id and reads the slots
// accordingly. Out-parameters (e.g. glGetIntegerv) are guest addresses the host
// writes back into via KMemory64::memcpyToGuest.

#ifndef __GL64BRIDGE_ABI_H__
#define __GL64BRIDGE_ABI_H__

#include <stdint.h>

// Private syscall number, well outside the Linux x86-64 ABI range (max ~547 as
// of 6.x). 'GL' = 0x474C in the high bits keeps it recognizable in logs and
// collision-free against any real syscall.
#define GL64_SYSCALL_NR  ((uint64_t)0x474C0000ULL)

// Fixed argument block. 16 slots comfortably covers every core-GL entry point
// used for first light (max real arity is well under that). Kept POD with a
// stable layout so guest and host agree byte-for-byte.
#define GL64_MAX_ARGS 16
typedef struct GL64Args {
    uint64_t a[GL64_MAX_ARGS];
} GL64Args;

// Function ids. Append-only — never renumber, the guest libGL and host bridge
// are compiled from this same list. Grouped: GLX/context bootstrap first, then
// core GL needed for a clear+triangle / glxgears.
enum {
    // --- GLX / context bootstrap ---------------------------------------
    GL64_fn_glXQueryVersion = 1,        // (out major*, out minor*) -> Bool
    GL64_fn_glXQueryExtension,          // (out errorBase*, out eventBase*) -> Bool
    GL64_fn_glXQueryExtensionsString,   // () -> const char* (host-owned, see note)
    GL64_fn_glXChooseVisual,            // (attribList*) -> XVisualInfo* (guest sees opaque non-null)
    GL64_fn_glXCreateContext,           // (vis*, share, direct) -> GLXContext (opaque id)
    GL64_fn_glXCreateContextAttribsARB, // (config, share, direct, attribs*) -> GLXContext
    GL64_fn_glXChooseFBConfig,          // (screen, attribs*, out nelements*) -> GLXFBConfig*
    GL64_fn_glXGetFBConfigs,            // (screen, out nelements*) -> GLXFBConfig*
    GL64_fn_glXGetFBConfigAttrib,       // (config, attribute, out value*) -> int
    GL64_fn_glXGetVisualFromFBConfig,   // (config) -> XVisualInfo*
    GL64_fn_glXGetConfig,               // (vis*, attribute, out value*) -> int
    GL64_fn_glXMakeCurrent,             // (drawable, ctx) -> Bool
    GL64_fn_glXMakeContextCurrent,      // (draw, read, ctx) -> Bool
    GL64_fn_glXSwapBuffers,             // (drawable) -> void
    GL64_fn_glXDestroyContext,          // (ctx) -> void
    GL64_fn_glXIsDirect,                // (ctx) -> Bool (always True)
    GL64_fn_glXGetCurrentContext,       // () -> GLXContext
    GL64_fn_glXGetCurrentDrawable,      // () -> GLXDrawable
    GL64_fn_glXQueryServerString,       // (name) -> const char*
    GL64_fn_glXGetClientString,         // (name) -> const char*
    GL64_fn_glXWaitGL,                  // () -> void
    GL64_fn_glXWaitX,                   // () -> void
    GL64_fn_glXSwapIntervalEXT,         // (drawable, interval) -> void

    // --- core GL: state ------------------------------------------------
    GL64_fn_glClearColor = 200,         // (r,g,b,a : float)
    GL64_fn_glClear,                    // (mask)
    GL64_fn_glClearDepth,               // (depth : double)
    GL64_fn_glViewport,                 // (x,y,w,h)
    GL64_fn_glEnable,                   // (cap)
    GL64_fn_glDisable,                  // (cap)
    GL64_fn_glShadeModel,               // (mode)
    GL64_fn_glDepthFunc,                // (func)
    GL64_fn_glCullFace,                 // (mode)
    GL64_fn_glFrontFace,                // (mode)
    GL64_fn_glHint,                     // (target, mode)
    GL64_fn_glFlush,                    // ()
    GL64_fn_glFinish,                   // ()
    GL64_fn_glGetError,                 // () -> GLenum
    GL64_fn_glGetString,               // (name) -> const char*
    GL64_fn_glGetIntegerv,             // (pname, out params*)
    GL64_fn_glGetFloatv,               // (pname, out params*)
    GL64_fn_glColor3f,                  // (r,g,b : float)
    GL64_fn_glColor4f,                  // (r,g,b,a : float)

    // --- core GL: matrices --------------------------------------------
    GL64_fn_glMatrixMode = 260,         // (mode)
    GL64_fn_glLoadIdentity,             // ()
    GL64_fn_glPushMatrix,               // ()
    GL64_fn_glPopMatrix,                // ()
    GL64_fn_glFrustum,                  // (l,r,b,t,n,f : double)
    GL64_fn_glOrtho,                    // (l,r,b,t,n,f : double)
    GL64_fn_glTranslatef,               // (x,y,z : float)
    GL64_fn_glRotatef,                  // (angle,x,y,z : float)
    GL64_fn_glScalef,                   // (x,y,z : float)
    GL64_fn_glMultMatrixf,              // (m* -> 16 floats)

    // --- core GL: lighting / material ---------------------------------
    GL64_fn_glLightfv = 290,            // (light, pname, params* -> up to 4 floats)
    GL64_fn_glLightf,                   // (light, pname, param : float)
    GL64_fn_glMaterialfv,               // (face, pname, params* -> up to 4 floats)
    GL64_fn_glMaterialf,                // (face, pname, param : float)
    GL64_fn_glColorMaterial,            // (face, mode)
    GL64_fn_glNormal3f,                 // (x,y,z : float)

    // --- core GL: immediate-mode geometry -----------------------------
    GL64_fn_glBegin = 320,              // (mode)
    GL64_fn_glEnd,                      // ()
    GL64_fn_glVertex2f,                 // (x,y : float)
    GL64_fn_glVertex3f,                 // (x,y,z : float)

    // === programmable pipeline (GL2/GLES3, for wined3d / Direct3D) =====
    // These are the modern-GL entry points wined3d resolves through
    // glXGetProcAddressARB. They marshal 1:1 onto WebGL2 (GLES3) on the host.
    // Guest pointer args are GUEST virtual addresses; the host reads/writes
    // them via KMemory64. Buffer-relative pointers (VertexAttribPointer
    // `pointer`, DrawElements `indices`) are plain integer OFFSETS into the
    // bound buffer when a VBO/IBO is bound — passed through as u64, no guest
    // read. Handles returned by CreateShader/CreateProgram are real host GL
    // names handed straight back to the guest.

    // --- diagnostics ---
    GL64_fn_traceProc = 400,            // (name* , hit) -> log a glXGetProcAddress resolution

    // --- shaders / programs ---
    GL64_fn_glCreateShader = 410,       // (type) -> GLuint
    GL64_fn_glShaderSource,             // (shader, count, string** , length*) reads guest strings
    GL64_fn_glCompileShader,            // (shader)
    GL64_fn_glGetShaderiv,              // (shader, pname, out params*)
    GL64_fn_glGetShaderInfoLog,         // (shader, bufSize, out length*, out infoLog*)
    GL64_fn_glDeleteShader,             // (shader)
    GL64_fn_glCreateProgram,            // () -> GLuint
    GL64_fn_glAttachShader,             // (program, shader)
    GL64_fn_glDetachShader,             // (program, shader)
    GL64_fn_glBindAttribLocation,       // (program, index, name*)
    GL64_fn_glLinkProgram,              // (program)
    GL64_fn_glGetProgramiv,             // (program, pname, out params*)
    GL64_fn_glGetProgramInfoLog,        // (program, bufSize, out length*, out infoLog*)
    GL64_fn_glUseProgram,               // (program)
    GL64_fn_glDeleteProgram,            // (program)
    GL64_fn_glGetUniformLocation,       // (program, name*) -> GLint
    GL64_fn_glGetAttribLocation,        // (program, name*) -> GLint
    GL64_fn_glValidateProgram,          // (program)

    // --- uniforms ---
    GL64_fn_glUniform1i = 440,          // (loc, v0)
    GL64_fn_glUniform1f,                // (loc, v0:float)
    GL64_fn_glUniform2f,                // (loc, v0,v1:float)
    GL64_fn_glUniform3f,                // (loc, v0,v1,v2:float)
    GL64_fn_glUniform4f,                // (loc, v0,v1,v2,v3:float)
    GL64_fn_glUniform1fv,               // (loc, count, value*)
    GL64_fn_glUniform2fv,               // (loc, count, value*)
    GL64_fn_glUniform3fv,               // (loc, count, value*)
    GL64_fn_glUniform4fv,               // (loc, count, value*)
    GL64_fn_glUniform1iv,               // (loc, count, value*)
    GL64_fn_glUniformMatrix2fv,         // (loc, count, transpose, value*)
    GL64_fn_glUniformMatrix3fv,         // (loc, count, transpose, value*)
    GL64_fn_glUniformMatrix4fv,         // (loc, count, transpose, value*)

    // --- buffers (VBO / IBO) ---
    GL64_fn_glGenBuffers = 470,         // (n, out buffers*)
    GL64_fn_glBindBuffer,               // (target, buffer)
    GL64_fn_glBufferData,               // (target, size, data*, usage) reads guest data
    GL64_fn_glBufferSubData,            // (target, offset, size, data*) reads guest data
    GL64_fn_glDeleteBuffers,            // (n, buffers*)
    GL64_fn_glMapBufferRange,           // unsupported in WebGL2; returns 0 (guest falls back)

    // --- vertex attrib arrays / VAO ---
    GL64_fn_glEnableVertexAttribArray = 490,  // (index)
    GL64_fn_glDisableVertexAttribArray,       // (index)
    GL64_fn_glVertexAttribPointer,            // (index, size, type, normalized, stride, offset)
    GL64_fn_glGenVertexArrays,                // (n, out arrays*)
    GL64_fn_glBindVertexArray,                // (array)
    GL64_fn_glDeleteVertexArrays,             // (n, arrays*)
    GL64_fn_glVertexAttrib4f,                 // (index, x,y,z,w:float)

    // --- draws ---
    GL64_fn_glDrawArrays = 510,         // (mode, first, count)
    GL64_fn_glDrawElements,             // (mode, count, type, indices-offset)
    GL64_fn_glDrawRangeElements,        // (mode, start, end, count, type, offset)

    // --- modern state ---
    GL64_fn_glBlendFunc = 530,          // (sfactor, dfactor)
    GL64_fn_glBlendFuncSeparate,        // (srcRGB, dstRGB, srcA, dstA)
    GL64_fn_glBlendEquation,            // (mode)
    GL64_fn_glBlendEquationSeparate,    // (modeRGB, modeAlpha)
    GL64_fn_glBlendColor,               // (r,g,b,a:float)
    GL64_fn_glColorMask,                // (r,g,b,a:bool)
    GL64_fn_glDepthMask,                // (flag)
    GL64_fn_glStencilFunc,              // (func, ref, mask)
    GL64_fn_glStencilOp,                // (fail, zfail, zpass)
    GL64_fn_glStencilMask,              // (mask)
    GL64_fn_glStencilFuncSeparate,      // (face, func, ref, mask)
    GL64_fn_glStencilOpSeparate,        // (face, fail, zfail, zpass)
    GL64_fn_glStencilMaskSeparate,      // (face, mask)
    GL64_fn_glScissor,                  // (x,y,w,h)
    GL64_fn_glPolygonOffset,            // (factor, units : float)
    GL64_fn_glPolygonMode,              // (face, mode) — no-op on GLES
    GL64_fn_glDepthRange,               // (near, far : double)
    GL64_fn_glLineWidth,                // (width : float)
    GL64_fn_glPixelStorei,              // (pname, param)
    GL64_fn_glSampleCoverage,           // (value:float, invert)

    // --- textures (modern) ---
    GL64_fn_glActiveTexture = 560,      // (texture)
    GL64_fn_glGenTextures,              // (n, out textures*)
    GL64_fn_glBindTexture,              // (target, texture)
    GL64_fn_glDeleteTextures,           // (n, textures*)
    GL64_fn_glTexParameteri,            // (target, pname, param)
    GL64_fn_glTexParameterf,            // (target, pname, param:float)
    GL64_fn_glTexImage2D,               // (target, level, ifmt, w, h, border, fmt, type, pixels*) reads guest pixels
    GL64_fn_glTexSubImage2D,            // (target, level, x, y, w, h, fmt, type, pixels*) reads guest pixels
    GL64_fn_glGenerateMipmap,           // (target)
    GL64_fn_glCompressedTexImage2D,     // (target, level, ifmt, w, h, border, imageSize, data*)

    // --- queries / strings ---
    GL64_fn_glGetStringi = 590,         // (name, index) -> const char* (returns 0; guest stub)
    GL64_fn_glGetShaderSource,          // (shader, bufSize, out length*, out source*) — rarely used

    // --- ARB_sync (fence objects). wined3d's Present/flush path issues a fence
    //     then polls glClientWaitSync until signaled. We render synchronously, so
    //     a fence is always already-done; returning a non-null sync + an
    //     ALREADY_SIGNALED wait result unblocks the Present busy-wait. ---
    GL64_fn_glFenceSync = 600,          // (condition, flags) -> GLsync (opaque non-null id)
    GL64_fn_glClientWaitSync,           // (sync, flags, timeout) -> GLenum (ALREADY_SIGNALED)
    GL64_fn_glWaitSync,                 // (sync, flags, timeout) -> void (server-side; no-op)
    GL64_fn_glDeleteSync,               // (sync) -> void
    GL64_fn_glIsSync,                   // (sync) -> GLboolean
    GL64_fn_glGetSynciv,                // (sync, pname, bufSize, out length*, out values*) -> reports SIGNALED

    // --- occlusion / timer queries. wined3d uses these for occlusion + event
    //     queries; returning result-available=1 and a benign result keeps its
    //     query state machine from stalling. ---
    GL64_fn_glGenQueries = 610,         // (n, out ids*)
    GL64_fn_glDeleteQueries,            // (n, ids*)
    GL64_fn_glIsQuery,                  // (id) -> GLboolean
    GL64_fn_glBeginQuery,               // (target, id)
    GL64_fn_glEndQuery,                 // (target)
    GL64_fn_glGetQueryiv,               // (target, pname, out params*)
    GL64_fn_glGetQueryObjectiv,         // (id, pname, out params*)
    GL64_fn_glGetQueryObjectuiv,        // (id, pname, out params*)
    GL64_fn_glGetQueryObjectui64v,      // (id, pname, out params* (64-bit))
    GL64_fn_glQueryCounter,             // (id, target)

    // --- version mode. Guest shim asks the host which GL profile to
    //     advertise (host reads BW64_GLVERSION; "3*" -> 32, else 21), so
    //     D3D9-era apps keep the proven 2.1 strings while D3D11 experiments
    //     opt into 3.2 core. No guest libc dependency involved. ---
    GL64_fn_glVersionMode = 620,        // () -> 21, 32 or 33

    // =====================================================================
    // A2: the GL 3.x surface wined3d binds unconditionally in load_gl_funcs()
    // (adapter_gl.c: `USE_GL_FUNC(pfn) = wglGetProcAddress(#pfn)`, NO null check).
    // Before A2 every one of these resolved to the guest's gl64_noop, so
    // wined3d believed FBO / sampler / MRT / UBO state worked while nothing
    // reached the GPU -> D3D11CreateDevice returned E_FAIL (d3d11/device.c:
    // wined3d_device_gl_create_primary_opengl_context_cs bails, context_count
    // stays 0, adapter_gl_init_3d returns E_FAIL).
    //
    // MUST stay byte-identical to the enum in tools/rootfs64/libgl64/libgl64.c.
    // Explicit values (not implicit ++) so a mismatch is visible in review.
    // =====================================================================

    // --- framebuffer objects (GL 3.0 core / ARB_framebuffer_object) ---
    GL64_fn_glGenFramebuffers = 630,    // (n, out ids*)
    GL64_fn_glDeleteFramebuffers,       // (n, ids*)
    GL64_fn_glBindFramebuffer,          // (target, fb)
    GL64_fn_glIsFramebuffer,            // (fb) -> GLboolean
    GL64_fn_glFramebufferTexture1D,     // (target, attachment, textarget, tex, level)  [probe only]
    GL64_fn_glFramebufferTexture2D,     // (target, attachment, textarget, tex, level)
    GL64_fn_glFramebufferTexture3D,     // (target, attachment, textarget, tex, level, zoff)
    GL64_fn_glFramebufferTexture,       // (target, attachment, tex, level)
    GL64_fn_glFramebufferTextureLayer,  // (target, attachment, tex, level, layer)
    GL64_fn_glFramebufferRenderbuffer,  // (target, attachment, rb_target, rb)
    GL64_fn_glCheckFramebufferStatus,   // (target) -> GLenum  [LOAD-BEARING: != COMPLETE is a hard fail]
    GL64_fn_glBlitFramebuffer,          // (sx0,sy0,sx1,sy1, dx0,dy0,dx1,dy1, mask, filter)
    GL64_fn_glGenRenderbuffers = 642,   // (n, out ids*)
    GL64_fn_glDeleteRenderbuffers,      // (n, ids*)
    GL64_fn_glBindRenderbuffer,         // (target, rb)
    GL64_fn_glRenderbufferStorage,      // (target, internalformat, w, h)
    GL64_fn_glRenderbufferStorageMultisample, // (target, samples, internalformat, w, h)
    GL64_fn_glIsRenderbuffer,           // (rb) -> GLboolean
    GL64_fn_glGetRenderbufferParameteriv, // (rb, pname, out params*)
    GL64_fn_glGetFramebufferAttachmentParameteriv, // (target, attachment, pname, out params*)
    GL64_fn_glDrawBuffers,              // (n, bufs*)  [MRT]
    GL64_fn_glReadBuffer,               // (src)

    // --- sampler objects (GL 3.3 core / ARB_sampler_objects) ---
    // LOAD-BEARING for feature level: feature_level_from_caps() gates every
    // FL >= 10_0 on gl_info->supported[ARB_SAMPLER_OBJECTS].
    GL64_fn_glGenSamplers = 660,        // (n, out ids*)
    GL64_fn_glDeleteSamplers,           // (n, ids*)
    GL64_fn_glBindSampler,              // (unit, sampler)
    GL64_fn_glIsSampler,                // (sampler) -> GLboolean
    GL64_fn_glSamplerParameteri,        // (sampler, pname, param)
    GL64_fn_glSamplerParameterf,        // (sampler, pname, param)   [float bit-cast]
    GL64_fn_glSamplerParameteriv,       // (sampler, pname, values*)
    GL64_fn_glSamplerParameterfv,       // (sampler, pname, values*)
    GL64_fn_glSamplerParameterIiv,      // (sampler, pname, values*)
    GL64_fn_glSamplerParameterIuiv,     // (sampler, pname, values*)
    GL64_fn_glGetSamplerParameteriv,    // (sampler, pname, out params*)
    GL64_fn_glGetSamplerParameterfv,    // (sampler, pname, out params*)
    GL64_fn_glGetSamplerParameterIiv,   // (sampler, pname, out params*)
    GL64_fn_glGetSamplerParameterIuiv,  // (sampler, pname, out params*)

    // --- 3D / array textures ---
    GL64_fn_glTexImage3D = 690,         // (target, level, ifmt, w, h, d, border, fmt, type, pixels*)
    GL64_fn_glTexSubImage3D,            // (target, level, x,y,z, w,h,d, fmt, type, pixels*)
    GL64_fn_glCompressedTexImage3D,     // (target, level, ifmt, w, h, d, imageSize, data*)
    GL64_fn_glCompressedTexSubImage3D,  // (target, level, x,y,z, w,h,d, ifmt, imageSize, data*)
    GL64_fn_glTexImage2DMultisample,    // (target, samples, ifmt, w, h, fixedsample)
    GL64_fn_glTexImage3DMultisample,    // (target, samples, ifmt, w, h, d, fixedsample)

    // --- MRT / uniform blocks / buffer objects ---
    GL64_fn_glBindFragDataLocation = 700,   // (program, color, name*)
    GL64_fn_glGetFragDataIndex,            // (program, name*) -> GLint
    GL64_fn_glBindBufferRange,             // (target, index, buffer, offset, size)
    GL64_fn_glBindBufferBase,              // (target, index, buffer)
    GL64_fn_glGetUniformBlockIndex,        // (program, name*) -> GLuint
    GL64_fn_glUniformBlockBinding,         // (program, blockIndex, binding)
    GL64_fn_glGetActiveUniformBlockiv,     // (program, blockIndex, pname, out params*)
    GL64_fn_glGetActiveUniformBlockName,   // (program, blockIndex, bufSize, out length*, out name*)
    GL64_fn_glBufferStorage,               // (target, size, data*, flags)
    GL64_fn_glCopyBufferSubData,           // (readTarget, writeTarget, readOffset, writeOffset, size)
    GL64_fn_glGetBufferSubData,            // (target, offset, size, data*)
    GL64_fn_glGetBufferParameteriv,        // (target, pname, out params*)

    // --- int uniforms / introspection ---
    GL64_fn_glUniform2i = 730,          // (loc, v0, v1)
    GL64_fn_glUniform3i,                // (loc, v0, v1, v2)
    GL64_fn_glUniform4i,                // (loc, v0, v1, v2, v3)
    GL64_fn_glUniform2iv,               // (loc, n, values*)
    GL64_fn_glUniform3iv,               // (loc, n, values*)
    GL64_fn_glUniform4iv,               // (loc, n, values*)
    GL64_fn_glGetUniformfv,             // (program, locations*, out values*)
    GL64_fn_glGetUniformiv,             // (program, locations*, out values*)
    GL64_fn_glGetActiveUniform,         // (program, index, bufSize, out length*, out name*)
    GL64_fn_glGetAttachedShaders,       // (program, maxCount, out count*, out shaders*)
    GL64_fn_glGetShaderSourceImpl,      // (shader, bufSize, out length*, out source*)
    GL64_fn_glGetTexParameteriv,        // (target, pname, out params*)
    GL64_fn_glGetTexLevelParameteriv,   // (target, level, pname, out params*)
    GL64_fn_glGetTextureParameteriv,    // (texture, pname, out params*)
    GL64_fn_glGetTextureLevelParameteriv, // (texture, level, pname, out params*)
    GL64_fn_glGetCompressedTexImage,    // (target, level, out image*)
    GL64_fn_glCompressedTexSubImage2D,  // (target, level, x, y, w, h, format, imageSize, data*)

    // --- indexed state (GL 3.0 core / ARB_blend_func_extended) ---
    GL64_fn_glEnablei = 760,           // (index, cap)
    GL64_fn_glDisablei,                // (index, cap)
    GL64_fn_glIsEnabledi,              // (index, cap) -> GLboolean
    GL64_fn_glBlendEquationi,          // (buf, mode)
    GL64_fn_glBlendEquationSeparatei,  // (buf, rgb, alpha)
    GL64_fn_glBlendFunci,              // (buf, src, dst)
    GL64_fn_glBlendFuncSeparatei,      // (buf, srcRGB, dstRGB, srcA, dstA)
    GL64_fn_glColorMaski,              // (buf, r, g, b, a)
    GL64_fn_glMinSampleShading,        // (value)

    // --- instancing / base vertex ---
    GL64_fn_glVertexAttribDivisor = 780, // (index, divisor)
    GL64_fn_glDrawArraysInstanced,       // (mode, first, count, primcount)
    GL64_fn_glDrawElementsInstanced,     // (mode, count, type, indices*, primcount)
    GL64_fn_glDrawArraysInstancedBaseInstance, // (mode, first, count, primcount, baseInstance)
    GL64_fn_glDrawElementsInstancedBaseVertexBaseInstance, // (mode,count,type,indices*,primcount,baseVertex,baseInstance)
    GL64_fn_glDrawElementsBaseVertex,    // (mode, count, type, indices*, baseVertex)
    GL64_fn_glDrawRangeElementsBaseVertex, // (mode, start, end, count, type, indices*, baseVertex)

    // --- best-effort / safe no-ops (never called before a working device) ---
    GL64_fn_glDebugMessageCallback = 800, // (callback*, user*)
    GL64_fn_glDebugMessageControl,       // (source, type, id, severity, count, ids*, enabled)
    GL64_fn_glDebugMessageInsert,        // (source, type, id, severity, length, buf*)
    GL64_fn_glGetDebugMessageLog,        // (count, sources*, types*, ids*, sevs*, lens*, log*) -> 0 msgs
    GL64_fn_glBeginTransformFeedback,    // (mode)
    GL64_fn_glEndTransformFeedback,      // ()
    GL64_fn_glTransformFeedbackVaryings, // (program, count, varyings*, mode)
    GL64_fn_glPointParameteri,           // (pname, param)
    GL64_fn_glPointParameteriv,          // (pname, params*)
    GL64_fn_glPointParameterf,           // (pname, param)
    GL64_fn_glPointParameterfv,          // (pname, params*)
    GL64_fn_glTexBuffer,                 // (target, internalformat, buffer)
    GL64_fn_glTexBufferRange,            // (target, internalformat, buffer, offset, size)
    GL64_fn_glTexBufferARB,              // (target, internalformat, buffer)
    GL64_fn_glTexBufferRangeARB,         // (target, internalformat, buffer, offset, size)
    GL64_fn_glTextureBarrierNV,          // ()
    GL64_fn_glFinalCombinerInputNV,      // (target, input, inputName)
    GL64_fn_glVertexAttrib1f = 817,      // (index, v0)
    GL64_fn_glVertexAttrib2f,            // (index, v0, v1)
    GL64_fn_glVertexAttrib3f,            // (index, v0, v1, v2)
    GL64_fn_glVertexAttrib1fv,           // (index, v*)
    GL64_fn_glVertexAttrib2fv,
    GL64_fn_glVertexAttrib3fv,
    GL64_fn_glVertexAttrib4fv,
    GL64_fn_glVertexAttrib1d = 824,      // (index, v0) [double bit-cast]
    GL64_fn_glVertexAttrib2d,
    GL64_fn_glVertexAttrib3d,
    GL64_fn_glVertexAttrib4d,
    GL64_fn_glVertexAttrib1dv = 828,     // (index, v*)
    GL64_fn_glVertexAttrib2dv,
    GL64_fn_glVertexAttrib3dv,
    GL64_fn_glVertexAttrib4dv,
    GL64_fn_glVertexAttribI4i = 832,     // (index, x, y, z, w)
    GL64_fn_glVertexAttribI4ui,          // (index, x, y, z, w)
    GL64_fn_glVertexAttribI4iv,          // (index, v*)
    GL64_fn_glVertexAttribI4uiv,         // (index, v*)

    // --- appended in A2 cycle 2 (never renumber; see the append-only note) ---
    // glPolygonOffsetClamp is the THIRD of the three conditions
    // feature_level_from_caps() requires before it will return ANY level >= 10_0
    // (the others are GL 3.2 and ARB_sampler_objects), so without it the D3D11
    // device stays capped at 9_3 no matter how much else is real.
    GL64_fn_glPolygonOffsetClamp = 840,  // (factor, units, clamp)
    GL64_fn_glDrawElementsInstancedBaseVertex, // (mode,count,type,indices*,primcount,baseVertex)
    GL64_fn_glMultiDrawElementsBaseVertex, // (mode,count*,type,indices**,primcount,baseVertex*)
    GL64_fn_glTextureBarrier,            // ()

    // A3 functional adapter probes (append-only).
    GL64_fn_glReadPixels = 850,        // (x,y,w,h,format,type,pixels*)
    GL64_fn_glGetTexImage = 851,       // (target,level,format,type,pixels*)

    // C7: immutable storage (append-only). Wine allocates depth/stencil probe
    // textures via glTexStorage*; unimplemented they were silent no-ops, so
    // attachments referenced storage that never existed (and the calls were
    // invisible in the trace).
    GL64_fn_glTexStorage2D = 852,      // (target,levels,ifmt,w,h)
    GL64_fn_glTexStorage3D = 853,      // (target,levels,ifmt,w,h,d)
    GL64_fn_glTexStorage1D = 854,      // (target,levels,ifmt,w) -> w x 1 2D

    // C10: multisample immutable storage (append-only). Wine disables the
    // whole ARB_texture_multisample extension when glTexStorage2DMultisample
    // resolves NULL. WebGL2 has no texStorage*Multisample entry points, but
    // texImage*Multisample allocates identical immutable multisample storage,
    // so the host routes there honestly (same drivers, same errors).
    GL64_fn_glTexStorage2DMultisample = 855, // (target,samples,ifmt,w,h,fixed)
    GL64_fn_glTexStorage3DMultisample = 856, // (target,samples,ifmt,w,h,d,fixed)
    GL64_fn_glGetMultisamplefv = 857,  // (pname,index,values* -> 2 floats)

    GL64_fn__MAX
};

#endif // __GL64BRIDGE_ABI_H__
