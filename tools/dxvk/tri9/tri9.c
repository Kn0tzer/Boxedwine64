/*
 * tri9.c — G2 bring-up app: D3D9 Clear + INDEXED triangle through DXVK.
 *
 * Same shape as tools/rootfs64/gltest/d3dtri.c (windowed 480x360, XYZRHW FVF
 * vertices, IMMEDIATE present, diagnostics on stderr) with two deliberate
 * differences, both load-bearing for the gate in web/tests/scratch-dxvk.mjs:
 *
 *   1. DrawIndexedPrimitive (index buffer {0,1,2}) instead of DrawPrimitive.
 *      DXVK draws ~100% indexed, and the vk64 bridge only records what crosses
 *      as vkCmdDrawIndexed — a non-indexed triangle would prove nothing about
 *      the path DXVK actually drives.
 *   2. A machine-readable verdict: "tri9: RESULT 0" after 70 presented frames
 *      (or "tri9: RESULT 1" + reason on any failure), so the probe waits on
 *      the app's own word the way scratch-vk.mjs waits on "vkfix: RESULT".
 *
 * Runs against DXVK's native d3d9.dll (WINEDLLOVERRIDES=d3d9=n, dll staged next
 * to this exe). SOFTWARE_VERTEXPROCESSING like d3dtri — avoids the HW-VP caps
 * path, which is orthogonal to what G2 is proving.
 *
 * Build (mingw-w64, any flavor):
 *   x86_64-w64-mingw32-gcc -O2 -o tri9.exe tri9.c -ld3d9 -lgdi32 -luser32
 */
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d9.h>
#include <stdio.h>

#define TRI9_FRAMES 70
#define TRI9_W 480
#define TRI9_H 360

static void dbg(const char* s) {
    fprintf(stderr, "%s", s); fflush(stderr);
    OutputDebugStringA(s);
}
#define FAIL(...) do { char b[256]; wsprintfA(b, __VA_ARGS__); dbg(b); \
    dbg("tri9: RESULT 1\n"); return 1; } while (0)

typedef struct { float x, y, z, rhw; DWORD color; } CUSTOMVERTEX;
#define D3DFVF_CUSTOMVERTEX (D3DFVF_XYZRHW | D3DFVF_DIFFUSE)

static IDirect3D9* g_d3d = NULL;
static IDirect3DDevice9* g_dev = NULL;
static IDirect3DVertexBuffer9* g_vb = NULL;
static IDirect3DIndexBuffer9* g_ib = NULL;

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_CLOSE || m == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProc(h, m, w, l);
}

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR cmd, int show) {
    (void)hPrev; (void)cmd; (void)show;
    dbg("tri9: WinMain start (D3D9 clear + indexed triangle)\n");

    WNDCLASSA wc = {0};
    wc.lpfnWndProc = WndProc;
    wc.hInstance = hInst;
    wc.lpszClassName = "tri9";
    RegisterClassA(&wc);
    HWND hwnd = CreateWindowA("tri9", "Boxedwine64 DXVK tri9",
                              WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                              CW_USEDEFAULT, CW_USEDEFAULT, TRI9_W, TRI9_H,
                              0, 0, hInst, 0);
    if (!hwnd) FAIL("tri9: FAIL CreateWindow\n");

    dbg("tri9: calling Direct3DCreate9...\n");
    g_d3d = Direct3DCreate9(D3D_SDK_VERSION);
    if (!g_d3d) FAIL("tri9: FAIL Direct3DCreate9 returned NULL\n");
    dbg("tri9: Direct3DCreate9 OK; creating device...\n");

    D3DPRESENT_PARAMETERS pp; ZeroMemory(&pp, sizeof(pp));
    pp.Windowed = TRUE;
    pp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    pp.BackBufferWidth = TRI9_W;
    pp.BackBufferHeight = TRI9_H;
    pp.BackBufferFormat = D3DFMT_X8R8G8B8;
    pp.EnableAutoDepthStencil = TRUE;
    pp.AutoDepthStencilFormat = D3DFMT_D16;
    pp.PresentationInterval = D3DPRESENT_INTERVAL_IMMEDIATE;

    HRESULT hr = IDirect3D9_CreateDevice(g_d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
        hwnd, D3DCREATE_SOFTWARE_VERTEXPROCESSING, &pp, &g_dev);
    if (FAILED(hr)) FAIL("tri9: FAIL CreateDevice HAL hr=0x%08lx\n", hr);
    dbg("tri9: device created OK\n");

    CUSTOMVERTEX verts[] = {
        { 240.0f,  60.0f, 0.5f, 1.0f, 0xffff0000 },
        { 420.0f, 300.0f, 0.5f, 1.0f, 0xff00ff00 },
        {  60.0f, 300.0f, 0.5f, 1.0f, 0xff0000ff },
    };
    if (FAILED(IDirect3DDevice9_CreateVertexBuffer(g_dev, sizeof(verts), 0,
            D3DFVF_CUSTOMVERTEX, D3DPOOL_DEFAULT, &g_vb, NULL)))
        FAIL("tri9: FAIL CreateVertexBuffer\n");
    void* p = NULL;
    if (FAILED(IDirect3DVertexBuffer9_Lock(g_vb, 0, sizeof(verts), &p, 0)))
        FAIL("tri9: FAIL VB Lock\n");
    CopyMemory(p, verts, sizeof(verts));
    IDirect3DVertexBuffer9_Unlock(g_vb);

    WORD indices[] = { 0, 1, 2 };
    if (FAILED(IDirect3DDevice9_CreateIndexBuffer(g_dev, sizeof(indices), 0,
            D3DFMT_INDEX16, D3DPOOL_DEFAULT, &g_ib, NULL)))
        FAIL("tri9: FAIL CreateIndexBuffer\n");
    if (FAILED(IDirect3DIndexBuffer9_Lock(g_ib, 0, sizeof(indices), &p, 0)))
        FAIL("tri9: FAIL IB Lock\n");
    CopyMemory(p, indices, sizeof(indices));
    IDirect3DIndexBuffer9_Unlock(g_ib);

    IDirect3DDevice9_SetRenderState(g_dev, D3DRS_LIGHTING, FALSE);
    IDirect3DDevice9_SetRenderState(g_dev, D3DRS_CULLMODE, D3DCULL_NONE);

    MSG msg; int frames = 0;
    for (;;) {
        while (PeekMessageA(&msg, 0, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) goto done;
            TranslateMessage(&msg);
            DispatchMessageA(&msg);
        }
        IDirect3DDevice9_Clear(g_dev, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER,
            D3DCOLOR_XRGB(0, 40, 100), 1.0f, 0);
        if (SUCCEEDED(IDirect3DDevice9_BeginScene(g_dev))) {
            IDirect3DDevice9_SetStreamSource(g_dev, 0, g_vb, 0, sizeof(CUSTOMVERTEX));
            IDirect3DDevice9_SetIndices(g_dev, g_ib);
            IDirect3DDevice9_SetFVF(g_dev, D3DFVF_CUSTOMVERTEX);
            IDirect3DDevice9_DrawIndexedPrimitive(g_dev, D3DPT_TRIANGLELIST, 0, 0, 3, 0, 1);
            IDirect3DDevice9_EndScene(g_dev);
        }
        IDirect3DDevice9_Present(g_dev, NULL, NULL, NULL, NULL);
        frames++;
        if (frames == 1) dbg("tri9: first Present DONE\n");
        if (frames % 35 == 0) { char b[64]; wsprintfA(b, "tri9: frame %d presented\n", frames); dbg(b); }
        if (frames >= TRI9_FRAMES) break;
        Sleep(16);
    }
done:
    if (g_ib)  IDirect3DIndexBuffer9_Release(g_ib);
    if (g_vb)  IDirect3DVertexBuffer9_Release(g_vb);
    if (g_dev) IDirect3DDevice9_Release(g_dev);
    if (g_d3d) IDirect3D9_Release(g_d3d);
    { char b[64]; wsprintfA(b, "tri9: %d frames presented\ntri9: RESULT 0\n", frames); dbg(b); }
    return 0;
}
