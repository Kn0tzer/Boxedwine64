/*
 * texquad9.cpp — D3D9 gate probe (b): textured quad.
 *
 * Loads checker.bmp from disk (manual 24-bit BMP parse, no D3DX), stages it
 * SYSTEMMEM -> UpdateTexture -> DEFAULT pool, then draws an indexed textured
 * quad with linear filtering. Isolates texture creation, host->device staging
 * (vkCmdCopyBufferToImage under DXVK), image views and samplers, on top of
 * the draw path tri9 covers. checker.bmp must sit next to the exe.
 *
 * Build: x86_64-w64-mingw32-g++ -O2 -o texquad9.exe texquad9.cpp -ld3d9 -lgdi32 -luser32
 */
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d9.h>
#include <stdio.h>
#include <stdlib.h>

#define FRAMES 40
#define W 640
#define H 480
#define TEXBMP "checker.bmp"

#define FAIL(...) do { printf(__VA_ARGS__); printf("texquad9: RESULT 1\n"); return 1; } while (0)

typedef struct { float x, y, z, rhw; DWORD color; float u, v; } VERTEX;
#define FVF (D3DFVF_XYZRHW | D3DFVF_DIFFUSE | D3DFVF_TEX1)

/* 24-bit uncompressed BMP -> freshly malloc'd X8R8G8B8 pixels. */
static DWORD* load_bmp(const char* path, int* pw, int* ph) {
    unsigned char h[54]; FILE* f = fopen(path, "rb");
    if (!f || fread(h, 1, 54, f) != 54) { if (f) fclose(f); return NULL; }
    int w = h[18] | (h[19]<<8) | (h[20]<<16) | (h[21]<<24),
        hh = h[22] | (h[23]<<8) | (h[24]<<16) | (h[25]<<24),
        bpp = h[28] | (h[29]<<8), comp = h[30] | (h[31]<<8),
        off = h[10] | (h[11]<<8) | (h[12]<<16) | (h[13]<<24);
    if (h[0] != 'B' || h[1] != 'M' || bpp != 24 || comp != 0 ||
        w <= 0 || hh <= 0 || w > 512 || hh > 512) { fclose(f); return NULL; }
    int row = ((w * 3 + 3) / 4) * 4;
    unsigned char* raw = (unsigned char*)malloc(row * hh);
    fseek(f, off, SEEK_SET);
    size_t n = fread(raw, 1, row * hh, f); fclose(f);
    if (n != (size_t)(row * hh)) { free(raw); return NULL; }
    DWORD* px = (DWORD*)malloc(w * hh * 4);
    for (int y = 0; y < hh; y++) for (int x = 0; x < w; x++) {
        unsigned char* p = raw + (hh - 1 - y) * row + x * 3;  // BMP is bottom-up
        px[y * w + x] = ((DWORD)p[2] << 16) | ((DWORD)p[1] << 8) | p[0];
    }
    free(raw); *pw = w; *ph = hh;
    return px;
}

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_CLOSE || m == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProc(h, m, w, l);
}

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR cmd, int show) {
    (void)hPrev; (void)cmd; (void)show;
    printf("texquad9: start (textured quad)\n"); fflush(stdout);
    WNDCLASSA wc = {0};
    wc.lpfnWndProc = WndProc; wc.hInstance = hInst; wc.lpszClassName = "texquad9";
    RegisterClassA(&wc);
    HWND hwnd = CreateWindowA("texquad9", "texquad9", WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                              CW_USEDEFAULT, CW_USEDEFAULT, W, H, 0, 0, hInst, 0);
    if (!hwnd) FAIL("texquad9: FAIL CreateWindow\n");
    IDirect3D9* d3d = Direct3DCreate9(D3D_SDK_VERSION);
    if (!d3d) FAIL("texquad9: FAIL Direct3DCreate9 returned NULL\n");
    D3DPRESENT_PARAMETERS pp; ZeroMemory(&pp, sizeof(pp));
    pp.Windowed = TRUE; pp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    pp.BackBufferWidth = W; pp.BackBufferHeight = H;
    pp.BackBufferFormat = D3DFMT_X8R8G8B8; pp.PresentationInterval = D3DPRESENT_INTERVAL_IMMEDIATE;
    IDirect3DDevice9* dev = NULL;
    HRESULT hr = IDirect3D9_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
        hwnd, D3DCREATE_SOFTWARE_VERTEXPROCESSING, &pp, &dev);
    if (FAILED(hr)) FAIL("texquad9: FAIL CreateDevice hr=0x%08lx\n", hr);

    int tw, th; DWORD* px = load_bmp(TEXBMP, &tw, &th);
    if (!px) FAIL("texquad9: FAIL loading %s\n", TEXBMP);
    printf("texquad9: %s loaded (%dx%d)\n", TEXBMP, tw, th); fflush(stdout);

    IDirect3DTexture9 *sysTex = NULL, *devTex = NULL;
    if (FAILED(IDirect3DDevice9_CreateTexture(dev, tw, th, 1, 0, D3DFMT_X8R8G8B8, D3DPOOL_SYSTEMMEM, &sysTex, NULL)))
        FAIL("texquad9: FAIL CreateTexture SYSTEMMEM\n");
    D3DLOCKED_RECT lr;
    if (FAILED(IDirect3DTexture9_LockRect(sysTex, 0, &lr, NULL, 0))) FAIL("texquad9: FAIL LockRect\n");
    for (int y = 0; y < th; y++)  // pitch may exceed w*4: copy row by row
        CopyMemory((BYTE*)lr.pBits + y * lr.Pitch, px + y * tw, tw * 4);
    IDirect3DTexture9_UnlockRect(sysTex, 0);
    free(px);
    if (FAILED(IDirect3DDevice9_CreateTexture(dev, tw, th, 1, 0, D3DFMT_X8R8G8B8, D3DPOOL_DEFAULT, &devTex, NULL)))
        FAIL("texquad9: FAIL CreateTexture DEFAULT\n");
    if (FAILED(IDirect3DDevice9_UpdateTexture(dev, (IDirect3DBaseTexture9*)sysTex, (IDirect3DBaseTexture9*)devTex)))
        FAIL("texquad9: FAIL UpdateTexture\n");
    IDirect3DTexture9_Release(sysTex);
    printf("texquad9: texture staged (SYSTEMMEM -> UpdateTexture -> DEFAULT)\n"); fflush(stdout);

    VERTEX v[] = {  // 4x-tiled UVs to exercise the sampler
        {  64.0f,  48.0f, 0.5f, 1.0f, 0xffffffff, 0.0f, 0.0f }, { 576.0f,  48.0f, 0.5f, 1.0f, 0xffffffff, 4.0f, 0.0f },
        { 576.0f, 432.0f, 0.5f, 1.0f, 0xffffffff, 4.0f, 4.0f }, {  64.0f, 432.0f, 0.5f, 1.0f, 0xffffffff, 0.0f, 4.0f },
    };
    WORD idx[] = { 0, 1, 2, 0, 2, 3 };
    IDirect3DVertexBuffer9* vb = NULL; IDirect3DIndexBuffer9* ib = NULL; void* p = NULL;
    if (FAILED(IDirect3DDevice9_CreateVertexBuffer(dev, sizeof(v), 0, FVF, D3DPOOL_DEFAULT, &vb, NULL)))
        FAIL("texquad9: FAIL CreateVertexBuffer\n");
    IDirect3DVertexBuffer9_Lock(vb, 0, sizeof(v), &p, 0);
    CopyMemory(p, v, sizeof(v)); IDirect3DVertexBuffer9_Unlock(vb);
    if (FAILED(IDirect3DDevice9_CreateIndexBuffer(dev, sizeof(idx), 0, D3DFMT_INDEX16, D3DPOOL_DEFAULT, &ib, NULL)))
        FAIL("texquad9: FAIL CreateIndexBuffer\n");
    IDirect3DIndexBuffer9_Lock(ib, 0, sizeof(idx), &p, 0);
    CopyMemory(p, idx, sizeof(idx)); IDirect3DIndexBuffer9_Unlock(ib);

    IDirect3DDevice9_SetRenderState(dev, D3DRS_LIGHTING, FALSE);
    IDirect3DDevice9_SetRenderState(dev, D3DRS_CULLMODE, D3DCULL_NONE);
    IDirect3DDevice9_SetSamplerState(dev, 0, D3DSAMP_MINFILTER, D3DTEXF_LINEAR);
    IDirect3DDevice9_SetSamplerState(dev, 0, D3DSAMP_MAGFILTER, D3DTEXF_LINEAR);
    IDirect3DDevice9_SetSamplerState(dev, 0, D3DSAMP_ADDRESSU, D3DTADDRESS_WRAP);
    IDirect3DDevice9_SetSamplerState(dev, 0, D3DSAMP_ADDRESSV, D3DTADDRESS_WRAP);

    MSG msg; int frames = 0;
    for (;;) {
        while (PeekMessageA(&msg, 0, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) goto done;
            TranslateMessage(&msg); DispatchMessageA(&msg);
        }
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
        if (frames % 10 == 0) { printf("texquad9: frame %d presented\n", frames); fflush(stdout); }
        if (frames >= FRAMES) break;
        Sleep(16);
    }
done:
    if (ib) IDirect3DIndexBuffer9_Release(ib);
    if (vb) IDirect3DVertexBuffer9_Release(vb);
    if (devTex) IDirect3DTexture9_Release(devTex);
    if (dev) IDirect3DDevice9_Release(dev);
    if (d3d) IDirect3D9_Release(d3d);
    printf("texquad9: %d frames presented\ntexquad9: RESULT 0\n", frames);
    return 0;
}
