// GPL-2.0-or-later. Included only by the Emscripten gl64 bridge.
// This is a deliberately bounded fixed-function command stream, not a Vulkan
// or general programmable GL implementation. The browser refuses unsupported
// commands and falls back to the upstream WebGL surface rather than lying.
#ifdef __EMSCRIPTEN__
#include <sstream>
namespace {
std::atomic<bool> bwGpuEnabled{false};
std::ostringstream bwGpuCommands;
int bwGpuCommandCount = 0;
bool bwGpuOverflow = false;
void bwGpuCapture(CPU64* cpu, U64 fn, const GL64Args& args) {
    if (!bwGpuEnabled.load(std::memory_order_relaxed)) return;
    if (fn == GL64_fn_glXSwapBuffers) {
        std::string json = "{\"width\":" + std::to_string(g_drawW) +
            ",\"height\":" + std::to_string(g_drawH) + ",\"overflow\":" +
            (bwGpuOverflow ? "true" : "false") + ",\"commands\":[" + bwGpuCommands.str() + "]}";
        // Synchronous proxy copies the string before its C++ storage is freed.
        // Only one hop per frame, never one hop per vertex.
        MAIN_THREAD_EM_ASM({
            if (globalThis.window && window.bwGpuFrame) window.bwGpuFrame(UTF8ToString($0));
        }, json.c_str());
        bwGpuCommands.str(""); bwGpuCommands.clear(); bwGpuCommandCount = 0; bwGpuOverflow = false;
        return;
    }
    if (fn < 200 || fn == GL64_fn_traceProc || fn == GL64_fn_glGetError ||
        fn == GL64_fn_glGetString || fn == GL64_fn_glGetIntegerv || fn == GL64_fn_glGetFloatv ||
        fn == GL64_fn_glVersionMode) return;
    if (bwGpuCommandCount >= 100000) { bwGpuOverflow = true; return; }
    if (bwGpuCommandCount++) bwGpuCommands << ',';
    bwGpuCommands << '[' << fn;
    int count = 0;
    enum { Integer, Float, Double, Matrix } kind = Integer;
    switch (fn) {
        case GL64_fn_glClearColor: case GL64_fn_glColor4f: count = 4; kind = Float; break;
        case GL64_fn_glColor3f: case GL64_fn_glNormal3f: case GL64_fn_glVertex3f:
        case GL64_fn_glTranslatef: case GL64_fn_glScalef: count = 3; kind = Float; break;
        case GL64_fn_glVertex2f: count = 2; kind = Float; break;
        case GL64_fn_glRotatef: count = 4; kind = Float; break;
        case GL64_fn_glClearDepth: count = 1; kind = Double; break;
        case GL64_fn_glFrustum: case GL64_fn_glOrtho: count = 6; kind = Double; break;
        case GL64_fn_glMultMatrixf: count = 16; kind = Matrix; break;
        case GL64_fn_glViewport: count = 4; break;
        case GL64_fn_glClear: case GL64_fn_glEnable: case GL64_fn_glDisable:
        case GL64_fn_glShadeModel: case GL64_fn_glDepthFunc: case GL64_fn_glCullFace:
        case GL64_fn_glFrontFace: case GL64_fn_glMatrixMode: case GL64_fn_glBegin:
        case GL64_fn_glDepthMask: count = 1; break;
        default: break;
    }
    float matrix[16] = {};
    if (kind == Matrix) readFloats(cpu, args.a[0], matrix, 16);
    for (int i = 0; i < count; i++) {
        double value = kind == Float ? af(args, i) : kind == Double ? ad(args, i) :
                       kind == Matrix ? matrix[i] : (double)(int64_t)args.a[i];
        if (!std::isfinite(value)) { bwGpuOverflow = true; value = 0; }
        bwGpuCommands << ',' << value;
    }
    bwGpuCommands << ']';
}
}
extern "C" EMSCRIPTEN_KEEPALIVE void bw64_gpu_capture(int enabled) {
    bwGpuEnabled.store(enabled != 0, std::memory_order_relaxed);
}
#endif
