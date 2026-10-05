/*
 * clear9.cpp — D3D9 gate probe (a): clear-only, no geometry.
 *
 * Isolates swapchain creation + per-frame Present. There is no vertex/index
 * buffer, no texture, no draw call at all: if the VK trap log shows
 * vkCreateSwapchainKHR / vkAcquireNextImageKHR / vkQueueSubmit /
 * vkQueuePresentKHR with zero vkCmdDraw*, the present path works and any
 * failure in the other probes is in draw/state setup instead.
 *
 * Build: x86_64-w64-mingw32-g++ -O2 -o clear9.exe clear9.cpp -ld3d9 -lgdi32 -luser32
 */
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d9.h>
#include <stdio.h>

#define FRAMES 30
#define W 640
#define H 480

#define FAIL(...) do { printf(__VA_ARGS__); printf("clear9: RESULT 1\n"); return 1; } while (0)

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_CLOSE || m == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProc(h, m, w, l);
}

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR cmd, int show) {
    (void)hPrev; (void)cmd; (void)show;
    printf("clear9: start (clear-only, no geometry)\n"); fflush(stdout);

    WNDCLASSA wc = {0};
    wc.lpfnWndProc = WndProc; wc.hInstance = hInst; wc.lpszClassName = "clear9";
    RegisterClassA(&wc);
    HWND hwnd = CreateWindowA("clear9", "clear9", WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                              CW_USEDEFAULT, CW_USEDEFAULT, W, H, 0, 0, hInst, 0);
    if (!hwnd) FAIL("clear9: FAIL CreateWindow\n");

    IDirect3D9* d3d = Direct3DCreate9(D3D_SDK_VERSION);
    if (!d3d) FAIL("clear9: FAIL Direct3DCreate9 returned NULL\n");

    D3DPRESENT_PARAMETERS pp; ZeroMemory(&pp, sizeof(pp));
    pp.Windowed = TRUE;
    pp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    pp.BackBufferWidth = W; pp.BackBufferHeight = H;
    pp.BackBufferFormat = D3DFMT_X8R8G8B8;
    pp.PresentationInterval = D3DPRESENT_INTERVAL_IMMEDIATE;

    IDirect3DDevice9* dev = NULL;
    HRESULT hr = IDirect3D9_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
        hwnd, D3DCREATE_SOFTWARE_VERTEXPROCESSING, &pp, &dev);
    if (FAILED(hr)) FAIL("clear9: FAIL CreateDevice hr=0x%08lx\n", hr);
    printf("clear9: device OK, presenting %d frames\n", FRAMES); fflush(stdout);

    MSG msg; int frames = 0;
    for (;;) {
        while (PeekMessageA(&msg, 0, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) goto done;
            TranslateMessage(&msg); DispatchMessageA(&msg);
        }
        BYTE c = (BYTE)(frames * 8);  // cycling clear color proves new frames land
        IDirect3DDevice9_Clear(dev, 0, NULL, D3DCLEAR_TARGET,
                               D3DCOLOR_XRGB(c, 40, 100), 1.0f, 0);
        IDirect3DDevice9_Present(dev, NULL, NULL, NULL, NULL);
        frames++;
        if (frames % 10 == 0) { printf("clear9: frame %d presented\n", frames); fflush(stdout); }
        if (frames >= FRAMES) break;
        Sleep(16);
    }
done:
    if (dev) IDirect3DDevice9_Release(dev);
    if (d3d) IDirect3D9_Release(d3d);
    printf("clear9: %d frames presented\nclear9: RESULT 0\n", frames);
    return 0;
}
