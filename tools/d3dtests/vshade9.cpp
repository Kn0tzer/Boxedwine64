/*
 * vshade9.cpp — D3D9 gate probe (c): vertex-colored indexed draw with a
 * changing "uniform" via UpdateTexture every frame.
 *
 * A 32x32 SYSTEMMEM texture is re-filled each frame (moving gradient) and
 * pushed to its DEFAULT-pool twin with UpdateTexture, then a vertex-colored
 * indexed quad is drawn over it (texture * vertex color). Exercises per-frame
 * staging submits (vkCmdCopyBufferToImage + barriers every frame) on top of
 * the indexed draw path tri9 covers.
 *
 * Build: x86_64-w64-mingw32-g++ -O2 -o vshade9.exe vshade9.cpp -ld3d9 -lgdi32 -luser32
 */
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d9.h>
#include <stdio.h>

#define FRAMES 50
#define W 640
#define H 480
#define TW 32
#define TH 32

#define FAIL(...) do { printf(__VA_ARGS__); printf("vshade9: RESULT 1\n"); return 1; } while (0)

typedef struct { float x, y, z, rhw; DWORD color; float u, v; } VERTEX;
#define FVF (D3DFVF_XYZRHW | D3DFVF_DIFFUSE | D3DFVF_TEX1)

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_CLOSE || m == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProc(h, m, w, l);
}

/* Frame-varying pixel pattern: the "uniform" that changes every frame. */
static void fill_pattern(DWORD* px, int frame) {
    for (int y = 0; y < TH; y++) for (int x = 0; x < TW; x++) {
        BYTE r = (BYTE)((x * 8 + frame * 5) & 255);
        BYTE g = (BYTE)((y * 8 + frame * 3) & 255);
        BYTE b = (BYTE)((frame * 7) & 255);
        px[y * TW + x] = ((DWORD)r << 16) | ((DWORD)g << 8) | b;
    }
}

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR cmd, int show) {
    (void)hPrev; (void)cmd; (void)show;
    printf("vshade9: start (indexed draw + per-frame UpdateTexture)\n"); fflush(stdout);
    WNDCLASSA wc = {0};
    wc.lpfnWndProc = WndProc; wc.hInstance = hInst; wc.lpszClassName = "vshade9";
    RegisterClassA(&wc);
    HWND hwnd = CreateWindowA("vshade9", "vshade9", WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                              CW_USEDEFAULT, CW_USEDEFAULT, W, H, 0, 0, hInst, 0);
    if (!hwnd) FAIL("vshade9: FAIL CreateWindow\n");
    IDirect3D9* d3d = Direct3DCreate9(D3D_SDK_VERSION);
    if (!d3d) FAIL("vshade9: FAIL Direct3DCreate9 returned NULL\n");
    D3DPRESENT_PARAMETERS pp; ZeroMemory(&pp, sizeof(pp));
    pp.Windowed = TRUE; pp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    pp.BackBufferWidth = W; pp.BackBufferHeight = H;
    pp.BackBufferFormat = D3DFMT_X8R8G8B8; pp.PresentationInterval = D3DPRESENT_INTERVAL_IMMEDIATE;
    IDirect3DDevice9* dev = NULL;
    HRESULT hr = IDirect3D9_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
        hwnd, D3DCREATE_SOFTWARE_VERTEXPROCESSING, &pp, &dev);
    if (FAILED(hr)) FAIL("vshade9: FAIL CreateDevice hr=0x%08lx\n", hr);

    IDirect3DTexture9 *sysTex = NULL, *devTex = NULL;
    if (FAILED(IDirect3DDevice9_CreateTexture(dev, TW, TH, 1, 0, D3DFMT_X8R8G8B8, D3DPOOL_SYSTEMMEM, &sysTex, NULL)))
        FAIL("vshade9: FAIL CreateTexture SYSTEMMEM\n");
    if (FAILED(IDirect3DDevice9_CreateTexture(dev, TW, TH, 1, 0, D3DFMT_X8R8G8B8, D3DPOOL_DEFAULT, &devTex, NULL)))
        FAIL("vshade9: FAIL CreateTexture DEFAULT\n");
    printf("vshade9: dynamic texture pair created\n"); fflush(stdout);

    VERTEX v[] = {  // per-vertex tints multiply the moving texture
        {  96.0f,  72.0f, 0.5f, 1.0f, 0xffff8080, 0.0f, 0.0f }, { 544.0f,  72.0f, 0.5f, 1.0f, 0xff80ff80, 1.0f, 0.0f },
        { 544.0f, 408.0f, 0.5f, 1.0f, 0xff8080ff, 1.0f, 1.0f }, {  96.0f, 408.0f, 0.5f, 1.0f, 0xffffff80, 0.0f, 1.0f },
    };
    WORD idx[] = { 0, 1, 2, 0, 2, 3 };
    IDirect3DVertexBuffer9* vb = NULL; IDirect3DIndexBuffer9* ib = NULL; void* p = NULL;
    if (FAILED(IDirect3DDevice9_CreateVertexBuffer(dev, sizeof(v), 0, FVF, D3DPOOL_DEFAULT, &vb, NULL)))
        FAIL("vshade9: FAIL CreateVertexBuffer\n");
    IDirect3DVertexBuffer9_Lock(vb, 0, sizeof(v), &p, 0);
    CopyMemory(p, v, sizeof(v)); IDirect3DVertexBuffer9_Unlock(vb);
    if (FAILED(IDirect3DDevice9_CreateIndexBuffer(dev, sizeof(idx), 0, D3DFMT_INDEX16, D3DPOOL_DEFAULT, &ib, NULL)))
        FAIL("vshade9: FAIL CreateIndexBuffer\n");
    IDirect3DIndexBuffer9_Lock(ib, 0, sizeof(idx), &p, 0);
    CopyMemory(p, idx, sizeof(idx)); IDirect3DIndexBuffer9_Unlock(ib);

    IDirect3DDevice9_SetRenderState(dev, D3DRS_LIGHTING, FALSE);
    IDirect3DDevice9_SetRenderState(dev, D3DRS_CULLMODE, D3DCULL_NONE);
    IDirect3DDevice9_SetSamplerState(dev, 0, D3DSAMP_MINFILTER, D3DTEXF_LINEAR);
    IDirect3DDevice9_SetSamplerState(dev, 0, D3DSAMP_MAGFILTER, D3DTEXF_LINEAR);

    static DWORD px[TW * TH];  // frame-varying pattern buffer
    MSG msg; int frames = 0;
    for (;;) {
        while (PeekMessageA(&msg, 0, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) goto done;
            TranslateMessage(&msg); DispatchMessageA(&msg);
        }
        fill_pattern(px, frames);  // <-- the per-frame changing "uniform"
        D3DLOCKED_RECT lr;
        if (FAILED(IDirect3DTexture9_LockRect(sysTex, 0, &lr, NULL, 0))) FAIL("vshade9: FAIL LockRect\n");
        for (int y = 0; y < TH; y++)
            CopyMemory((BYTE*)lr.pBits + y * lr.Pitch, px + y * TW, TW * 4);
        IDirect3DTexture9_UnlockRect(sysTex, 0);
        if (FAILED(IDirect3DDevice9_UpdateTexture(dev, (IDirect3DBaseTexture9*)sysTex, (IDirect3DBaseTexture9*)devTex)))
            FAIL("vshade9: FAIL UpdateTexture frame %d\n", frames);

        IDirect3DDevice9_Clear(dev, 0, NULL, D3DCLEAR_TARGET, D3DCOLOR_XRGB(0, 40, 100), 1.0f, 0);
        if (SUCCEEDED(IDirect3DDevice9_BeginScene(dev))) {
            IDirect3DDevice9_SetStreamSource(dev, 0, vb, 0, sizeof(VERTEX));
            IDirect3DDevice9_SetIndices(dev, ib);
            IDirect3DDevice9_SetFVF(dev, FVF);
            IDirect3DDevice9_SetTexture(dev, 0, (IDirect3DBaseTexture9*)devTex);
            IDirect3DDevice9_DrawIndexedPrimitive(dev, D3DPT_TRIANGLELIST, 0, 0, 4, 0, 2);
            IDirect3DDevice9_EndScene(dev);
        }
        IDirect3DDevice9_Present(dev, NULL, NULL, NULL, NULL);
        frames++;
        if (frames % 10 == 0) { printf("vshade9: frame %d presented\n", frames); fflush(stdout); }
        if (frames >= FRAMES) break;
        Sleep(16);
    }
done:
    if (ib) IDirect3DIndexBuffer9_Release(ib);
    if (vb) IDirect3DVertexBuffer9_Release(vb);
    if (sysTex) IDirect3DTexture9_Release(sysTex);
    if (devTex) IDirect3DTexture9_Release(devTex);
    if (dev) IDirect3DDevice9_Release(dev);
    if (d3d) IDirect3D9_Release(d3d);
    printf("vshade9: %d frames presented\nvshade9: RESULT 0\n", frames);
    return 0;
}
