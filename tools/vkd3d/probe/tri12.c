/*
 * tri12.c — D3D12 first-light probe: D3D12CreateDevice + clear-only frames.
 *
 * Deliberately minimal: no DXGI swapchain, no shaders, no PSO. A committed
 * 2D texture is used directly as a render target; each frame clears it to
 * cornflower blue and submits. This exercises, in order:
 *   1. D3D12CreateDevice (vkd3d device-init gates: push descriptors,
 *      vertex divisor, mirror clamp, draw parameters, texel alignment)
 *   2. Command queue / allocator / list / fence
 *   3. Committed resource + RTV descriptor heap
 *   4. vkCmdBeginRendering (dynamic rendering) + clear via vkQueueSubmit2
 *
 * Machine-readable verdict on stderr: "tri12: RESULT 0" (N frames cleared
 * and submitted) or "tri12: RESULT 1" + reason.
 *
 * Build (mingw-w64):
 *   x86_64-w64-mingw32-gcc -O2 -o tri12.exe tri12.c -lole32
 */
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <initguid.h>
#include <d3d12.h>
#include <stdio.h>

#define TRI12_FRAMES 10
#define TRI12_W 256
#define TRI12_H 256

static void dbg(const char* s) { fprintf(stderr, "%s", s); fflush(stderr); }
#define FAIL(...) do { char b[512]; wsprintfA(b, __VA_ARGS__); dbg(b); \
    dbg("tri12: RESULT 1\n"); return 1; } while (0)
#define HRF(hr, what) do { if (FAILED(hr)) { char b[512]; \
    wsprintfA(b, "tri12: FAIL %s hr=0x%08X\n", what, (unsigned)(hr)); dbg(b); \
    dbg("tri12: RESULT 1\n"); return 1; } } while (0)

typedef HRESULT (WINAPI *PFN_D3D12_CREATE_DEVICE)(IUnknown*, D3D_FEATURE_LEVEL, REFIID, void**);

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR cmd, int show) {
    (void)hInst; (void)hPrev; (void)cmd; (void)show;
    dbg("tri12: WinMain start (D3D12 clear-only probe)\n");

    HMODULE d3d12 = LoadLibraryA("d3d12.dll");
    if (!d3d12) FAIL("tri12: FAIL LoadLibrary(d3d12.dll) err=%u\n", GetLastError());
    dbg("tri12: d3d12.dll loaded\n");

    PFN_D3D12_CREATE_DEVICE pD3D12CreateDevice =
        (PFN_D3D12_CREATE_DEVICE)GetProcAddress(d3d12, "D3D12CreateDevice");
    if (!pD3D12CreateDevice) FAIL("tri12: FAIL GetProcAddress(D3D12CreateDevice)\n");

    ID3D12Device* device = NULL;
    HRESULT hr = pD3D12CreateDevice(NULL, D3D_FEATURE_LEVEL_11_0,
                                    &IID_ID3D12Device, (void**)&device);
    if (FAILED(hr)) FAIL("tri12: FAIL D3D12CreateDevice hr=0x%08X\n", (unsigned)hr);
    dbg("tri12: D3D12CreateDevice OK\n");

    D3D12_COMMAND_QUEUE_DESC qd = {0};
    qd.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
    ID3D12CommandQueue* queue = NULL;
    HRF(ID3D12Device_CreateCommandQueue(device, &qd, &IID_ID3D12CommandQueue, (void**)&queue),
        "CreateCommandQueue");

    ID3D12CommandAllocator* alloc = NULL;
    HRF(ID3D12Device_CreateCommandAllocator(device, D3D12_COMMAND_LIST_TYPE_DIRECT,
        &IID_ID3D12CommandAllocator, (void**)&alloc), "CreateCommandAllocator");

    ID3D12GraphicsCommandList* list = NULL;
    HRF(ID3D12Device_CreateCommandList(device, 0, D3D12_COMMAND_LIST_TYPE_DIRECT,
        alloc, NULL, &IID_ID3D12GraphicsCommandList, (void**)&list), "CreateCommandList");
    /* Start closed; each frame resets. */
    HRF(ID3D12GraphicsCommandList_Close(list), "Close(initial)");

    D3D12_DESCRIPTOR_HEAP_DESC hd = {0};
    hd.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
    hd.NumDescriptors = 1;
    ID3D12DescriptorHeap* rtvHeap = NULL;
    HRF(ID3D12Device_CreateDescriptorHeap(device, &hd, &IID_ID3D12DescriptorHeap,
        (void**)&rtvHeap), "CreateDescriptorHeap(RTV)");

    D3D12_HEAP_PROPERTIES hp = {0};
    hp.Type = D3D12_HEAP_TYPE_DEFAULT;
    D3D12_RESOURCE_DESC rd = {0};
    rd.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    rd.Width = TRI12_W; rd.Height = TRI12_H; rd.DepthOrArraySize = 1;
    rd.MipLevels = 1; rd.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    rd.SampleDesc.Count = 1;
    rd.Flags = D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET;
    D3D12_CLEAR_VALUE cv = {0};
    cv.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    cv.Color[0] = 0.39f; cv.Color[1] = 0.58f; cv.Color[2] = 0.93f; cv.Color[3] = 1.0f;
    ID3D12Resource* target = NULL;
    HRF(ID3D12Device_CreateCommittedResource(device, &hp, D3D12_HEAP_FLAG_NONE, &rd,
        D3D12_RESOURCE_STATE_RENDER_TARGET, &cv,
        &IID_ID3D12Resource, (void**)&target), "CreateCommittedResource(RT)");
    dbg("tri12: render target created\n");

    /* COBJMACROS aggregate-return wrapper is broken in this mingw; call the
       vtable slot directly (GetCPUDescriptorHandleForHeapStart). */
    D3D12_CPU_DESCRIPTOR_HANDLE rtv;
    ((void (STDMETHODCALLTYPE *)(ID3D12DescriptorHeap*, D3D12_CPU_DESCRIPTOR_HANDLE*))
        rtvHeap->lpVtbl->GetCPUDescriptorHandleForHeapStart)(rtvHeap, &rtv);
    ID3D12Device_CreateRenderTargetView(device, target, NULL, rtv);

    ID3D12Fence* fence = NULL;
    HRF(ID3D12Device_CreateFence(device, 0, D3D12_FENCE_FLAG_NONE,
        &IID_ID3D12Fence, (void**)&fence), "CreateFence");
    HANDLE evt = CreateEventA(NULL, FALSE, FALSE, NULL);
    if (!evt) FAIL("tri12: FAIL CreateEvent\n");

    float clearColor[4] = { 0.39f, 0.58f, 0.93f, 1.0f };
    UINT64 fenceVal = 1;
    for (int f = 0; f < TRI12_FRAMES; f++) {
        HRF(ID3D12CommandAllocator_Reset(alloc), "Reset(alloc)");
        HRF(ID3D12GraphicsCommandList_Reset(list, alloc, NULL), "Reset(list)");
        ID3D12GraphicsCommandList_OMSetRenderTargets(list, 1, &rtv, FALSE, NULL);
        ID3D12GraphicsCommandList_ClearRenderTargetView(list, rtv, clearColor, 0, NULL);
        HRF(ID3D12GraphicsCommandList_Close(list), "Close(list)");
        ID3D12CommandList* lists[1] = { (ID3D12CommandList*)list };
        ID3D12CommandQueue_ExecuteCommandLists(queue, 1, lists);
        HRF(ID3D12CommandQueue_Signal(queue, fence, fenceVal), "Signal");
        if (ID3D12Fence_GetCompletedValue(fence) < fenceVal) {
            HRF(ID3D12Fence_SetEventOnCompletion(fence, fenceVal, evt), "SetEventOnCompletion");
            WaitForSingleObject(evt, 10000);
        }
        fenceVal++;
    }
    { char b[128]; wsprintfA(b, "tri12: %d frames cleared+submitted\ntri12: RESULT 0\n", TRI12_FRAMES); dbg(b); }
    return 0;
}
