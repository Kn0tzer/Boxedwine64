/*
 * tri12draw.c — D3D12 first-light draw test: device + swapchain + triangle.
 *
 * Extends tri12.c (clear-only) with the pieces the bridge's v2 frame builder
 * needs: DXGI swapchain, shaders, PSO, vertex buffer, DrawInstanced, Present.
 * Shaders are the vkd3d demo's precompiled DXBC blobs (triangle_vs.h /
 * triangle_ps.h): pass-through VS (POSITION+COLOR), color-interpolating PS.
 *
 * Machine-readable verdict on stderr: "tri12draw: RESULT 0" (N frames drawn
 * and presented) or "tri12draw: RESULT 1" + reason.
 *
 * Build (mingw-w64):
 *   x86_64-w64-mingw32-gcc -O2 -o tri12draw.exe tri12draw.c -lole32
 */
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <initguid.h>
#include <d3d12.h>
#include <dxgi1_2.h>
#include <dxgi1_4.h>
#include <stdio.h>

#include "triangle_vs.h"
#include "triangle_ps.h"

#define TRI12DRAW_FRAMES 10
#define TRI12DRAW_W 480
#define TRI12DRAW_H 360

static void dbg(const char* s) { fprintf(stderr, "%s", s); fflush(stderr); }
#define FAIL(...) do { char b[512]; wsprintfA(b, __VA_ARGS__); dbg(b); \
    dbg("tri12draw: RESULT 1\n"); return 1; } while (0)
#define HRF(hr, what) do { if (FAILED(hr)) { char b[512]; \
    wsprintfA(b, "tri12draw: FAIL %s hr=0x%08X\n", what, (unsigned)(hr)); dbg(b); \
    dbg("tri12draw: RESULT 1\n"); return 1; } } while (0)

typedef HRESULT (WINAPI *PFN_D3D12_CREATE_DEVICE)(IUnknown*, D3D_FEATURE_LEVEL, REFIID, void**);
typedef HRESULT (WINAPI *PFN_CREATE_DXGI_FACTORY2)(UINT, REFIID, void**);
typedef HRESULT (WINAPI *PFN_D3D12_SERIALIZE_ROOT_SIG)(const D3D12_ROOT_SIGNATURE_DESC*,
        D3D_ROOT_SIGNATURE_VERSION, ID3DBlob**, ID3DBlob**);

static LRESULT CALLBACK wndproc(HWND h, UINT m, WPARAM w, LPARAM l)
{
    return DefWindowProcA(h, m, w, l);
}

/* COBJMACROS aggregate-return wrapper is broken in this mingw (see tri12.c);
 * call the vtable slot directly for GetCPUDescriptorHandleForHeapStart. */
static void heap_start(ID3D12DescriptorHeap* heap, D3D12_CPU_DESCRIPTOR_HANDLE* out)
{
    ((void (STDMETHODCALLTYPE *)(ID3D12DescriptorHeap*, D3D12_CPU_DESCRIPTOR_HANDLE*))
        heap->lpVtbl->GetCPUDescriptorHandleForHeapStart)(heap, out);
}

struct vertex { float pos[3]; float col[4]; };

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR cmd, int show) {
    (void)hInst; (void)hPrev; (void)cmd; (void)show;
    dbg("tri12draw: WinMain start (D3D12 draw+present probe)\n");

    HMODULE d3d12 = LoadLibraryA("d3d12.dll");
    if (!d3d12) FAIL("tri12draw: FAIL LoadLibrary(d3d12.dll) err=%u\n", GetLastError());
    HMODULE dxgi = LoadLibraryA("dxgi.dll");
    if (!dxgi) FAIL("tri12draw: FAIL LoadLibrary(dxgi.dll) err=%u\n", GetLastError());
    dbg("tri12draw: d3d12.dll + dxgi.dll loaded\n");

    PFN_D3D12_CREATE_DEVICE pD3D12CreateDevice =
        (PFN_D3D12_CREATE_DEVICE)GetProcAddress(d3d12, "D3D12CreateDevice");
    if (!pD3D12CreateDevice) FAIL("tri12draw: FAIL GetProcAddress(D3D12CreateDevice)\n");
    PFN_CREATE_DXGI_FACTORY2 pCreateDXGIFactory2 =
        (PFN_CREATE_DXGI_FACTORY2)GetProcAddress(dxgi, "CreateDXGIFactory2");
    if (!pCreateDXGIFactory2) FAIL("tri12draw: FAIL GetProcAddress(CreateDXGIFactory2)\n");
    PFN_D3D12_SERIALIZE_ROOT_SIG pSerializeRootSig =
        (PFN_D3D12_SERIALIZE_ROOT_SIG)GetProcAddress(d3d12, "D3D12SerializeRootSignature");
    if (!pSerializeRootSig) FAIL("tri12draw: FAIL GetProcAddress(D3D12SerializeRootSignature)\n");

    ID3D12Device* device = NULL;
    HRESULT hr = pD3D12CreateDevice(NULL, D3D_FEATURE_LEVEL_11_0,
                                   &IID_ID3D12Device, (void**)&device);
    if (FAILED(hr)) FAIL("tri12draw: FAIL D3D12CreateDevice hr=0x%08X\n", (unsigned)hr);
    dbg("tri12draw: D3D12CreateDevice OK\n");

    WNDCLASSA wc = {0};
    wc.lpfnWndProc = wndproc;
    wc.hInstance = hInst;
    wc.lpszClassName = "TRI12DRAW";
    if (!RegisterClassA(&wc)) FAIL("tri12draw: FAIL RegisterClass err=%u\n", GetLastError());
    HWND hwnd = CreateWindowExA(0, "TRI12DRAW", "tri12draw",
                                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                                0, 0, TRI12DRAW_W, TRI12DRAW_H,
                                NULL, NULL, hInst, NULL);
    if (!hwnd) FAIL("tri12draw: FAIL CreateWindowEx err=%u\n", GetLastError());
    dbg("tri12draw: window created\n");

    D3D12_COMMAND_QUEUE_DESC qd = {0};
    qd.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
    ID3D12CommandQueue* queue = NULL;
    HRF(ID3D12Device_CreateCommandQueue(device, &qd, &IID_ID3D12CommandQueue, (void**)&queue),
        "CreateCommandQueue");

    IDXGIFactory2* factory = NULL;
    HRF(pCreateDXGIFactory2(0, &IID_IDXGIFactory2, (void**)&factory), "CreateDXGIFactory2");

    DXGI_SWAP_CHAIN_DESC1 scd = {0};
    scd.BufferCount = 2;
    scd.Width = TRI12DRAW_W; scd.Height = TRI12DRAW_H;
    scd.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    scd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    scd.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    scd.SampleDesc.Count = 1;
    IDXGISwapChain1* sc1 = NULL;
    HRF(IDXGIFactory2_CreateSwapChainForHwnd(factory, (IUnknown*)queue, hwnd,
        &scd, NULL, NULL, &sc1), "CreateSwapChainForHwnd");
    IDXGIFactory2_Release(factory);
    IDXGISwapChain1* swapchain = sc1;
    IDXGISwapChain3* sc3 = NULL;
    HRF(IDXGISwapChain1_QueryInterface(sc1, &IID_IDXGISwapChain3, (void**)&sc3),
        "QI(IDXGISwapChain3)");
    dbg("tri12draw: swapchain created\n");

    D3D12_DESCRIPTOR_HEAP_DESC hd = {0};
    hd.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
    hd.NumDescriptors = 2;
    ID3D12DescriptorHeap* rtvHeap = NULL;
    HRF(ID3D12Device_CreateDescriptorHeap(device, &hd, &IID_ID3D12DescriptorHeap,
        (void**)&rtvHeap), "CreateDescriptorHeap(RTV)");
    UINT rtvSize = ID3D12Device_GetDescriptorHandleIncrementSize(device,
        D3D12_DESCRIPTOR_HEAP_TYPE_RTV);

    ID3D12Resource* targets[2] = {NULL, NULL};
    D3D12_CPU_DESCRIPTOR_HANDLE rtv;
    heap_start(rtvHeap, &rtv);
    for (int i = 0; i < 2; i++) {
        HRF(IDXGISwapChain1_GetBuffer(sc1, i, &IID_ID3D12Resource, (void**)&targets[i]),
            "GetBuffer");
        ID3D12Device_CreateRenderTargetView(device, targets[i], NULL, rtv);
        rtv.ptr += rtvSize;
    }
    dbg("tri12draw: RTVs created\n");

    /* Empty root signature (input-assembler only). */
    D3D12_ROOT_SIGNATURE_DESC rsd = {0};
    rsd.Flags = D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT;
    ID3DBlob* rsBlob = NULL;
    HRF(pSerializeRootSig(&rsd, D3D_ROOT_SIGNATURE_VERSION_1, &rsBlob, NULL),
        "D3D12SerializeRootSignature");
    ID3D12RootSignature* rootSig = NULL;
    HRF(ID3D12Device_CreateRootSignature(device, 0, ID3D10Blob_GetBufferPointer(rsBlob),
        ID3D10Blob_GetBufferSize(rsBlob), &IID_ID3D12RootSignature, (void**)&rootSig),
        "CreateRootSignature");
    ID3D10Blob_Release(rsBlob);

    D3D12_INPUT_ELEMENT_DESC il[] = {
        {"POSITION", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, 0,
         D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
        {"COLOR", 0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, 12,
         D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
    };
    D3D12_GRAPHICS_PIPELINE_STATE_DESC pso = {0};
    pso.InputLayout.pInputElementDescs = il;
    pso.InputLayout.NumElements = 2;
    pso.pRootSignature = rootSig;
    pso.VS.pShaderBytecode = g_vs_main;
    pso.VS.BytecodeLength = sizeof(g_vs_main);
    pso.PS.pShaderBytecode = g_ps_main;
    pso.PS.BytecodeLength = sizeof(g_ps_main);
    pso.RasterizerState.FillMode = D3D12_FILL_MODE_SOLID;
    pso.RasterizerState.CullMode = D3D12_CULL_MODE_BACK;
    pso.RasterizerState.FrontCounterClockwise = FALSE;
    pso.RasterizerState.DepthClipEnable = TRUE;
    pso.RasterizerState.ConservativeRaster = D3D12_CONSERVATIVE_RASTERIZATION_MODE_OFF;
    pso.BlendState.RenderTarget[0].SrcBlend = D3D12_BLEND_ONE;
    pso.BlendState.RenderTarget[0].DestBlend = D3D12_BLEND_ZERO;
    pso.BlendState.RenderTarget[0].BlendOp = D3D12_BLEND_OP_ADD;
    pso.BlendState.RenderTarget[0].SrcBlendAlpha = D3D12_BLEND_ONE;
    pso.BlendState.RenderTarget[0].DestBlendAlpha = D3D12_BLEND_ZERO;
    pso.BlendState.RenderTarget[0].BlendOpAlpha = D3D12_BLEND_OP_ADD;
    pso.BlendState.RenderTarget[0].RenderTargetWriteMask = D3D12_COLOR_WRITE_ENABLE_ALL;
    pso.SampleMask = UINT_MAX;
    pso.PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
    pso.NumRenderTargets = 1;
    pso.RTVFormats[0] = DXGI_FORMAT_R8G8B8A8_UNORM;
    pso.SampleDesc.Count = 1;
    ID3D12PipelineState* pipeline = NULL;
    HRF(ID3D12Device_CreateGraphicsPipelineState(device, &pso,
        &IID_ID3D12PipelineState, (void**)&pipeline), "CreateGraphicsPipelineState");
    dbg("tri12draw: PSO created\n");

    ID3D12CommandAllocator* alloc = NULL;
    HRF(ID3D12Device_CreateCommandAllocator(device, D3D12_COMMAND_LIST_TYPE_DIRECT,
        &IID_ID3D12CommandAllocator, (void**)&alloc), "CreateCommandAllocator");
    ID3D12GraphicsCommandList* list = NULL;
    HRF(ID3D12Device_CreateCommandList(device, 0, D3D12_COMMAND_LIST_TYPE_DIRECT,
        alloc, pipeline, &IID_ID3D12GraphicsCommandList, (void**)&list),
        "CreateCommandList");
    HRF(ID3D12GraphicsCommandList_Close(list), "Close(initial)");

    /* Vertex buffer: RGB triangle. */
    struct vertex verts[3] = {
        {{ 0.0f,  0.5f, 0.0f}, {1.0f, 0.0f, 0.0f, 1.0f}},
        {{ 0.5f, -0.5f, 0.0f}, {0.0f, 1.0f, 0.0f, 1.0f}},
        {{-0.5f, -0.5f, 0.0f}, {0.0f, 0.0f, 1.0f, 1.0f}},
    };
    D3D12_HEAP_PROPERTIES hpu = {0};
    hpu.Type = D3D12_HEAP_TYPE_UPLOAD;
    D3D12_RESOURCE_DESC rdu = {0};
    rdu.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    rdu.Width = sizeof(verts);
    rdu.Height = 1; rdu.DepthOrArraySize = 1; rdu.MipLevels = 1;
    rdu.SampleDesc.Count = 1;
    rdu.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    ID3D12Resource* vb = NULL;
    HRF(ID3D12Device_CreateCommittedResource(device, &hpu, D3D12_HEAP_FLAG_NONE, &rdu,
        D3D12_RESOURCE_STATE_GENERIC_READ, NULL,
        &IID_ID3D12Resource, (void**)&vb), "CreateCommittedResource(VB)");
    void* mapped = NULL;
    D3D12_RANGE rr = {0, 0};
    HRF(ID3D12Resource_Map(vb, 0, &rr, &mapped), "Map(VB)");
    memcpy(mapped, verts, sizeof(verts));
    ID3D12Resource_Unmap(vb, 0, NULL);
    D3D12_VERTEX_BUFFER_VIEW vbv;
    vbv.BufferLocation = ID3D12Resource_GetGPUVirtualAddress(vb);
    vbv.SizeInBytes = sizeof(verts);
    vbv.StrideInBytes = sizeof(struct vertex);

    D3D12_VIEWPORT vp = {0, 0, (float)TRI12DRAW_W, (float)TRI12DRAW_H, 0.0f, 1.0f};
    D3D12_RECT sc = {0, 0, TRI12DRAW_W, TRI12DRAW_H};

    ID3D12Fence* fence = NULL;
    HRF(ID3D12Device_CreateFence(device, 0, D3D12_FENCE_FLAG_NONE,
        &IID_ID3D12Fence, (void**)&fence), "CreateFence");
    HANDLE evt = CreateEventA(NULL, FALSE, FALSE, NULL);
    if (!evt) FAIL("tri12draw: FAIL CreateEvent\n");

    float clearColor[4] = {0.0f, 0.2f, 0.4f, 1.0f};
    UINT64 fenceVal = 1;
    for (int f = 0; f < TRI12DRAW_FRAMES; f++) {
        UINT backIdx = IDXGISwapChain3_GetCurrentBackBufferIndex(sc3);
        HRF(ID3D12CommandAllocator_Reset(alloc), "Reset(alloc)");
        HRF(ID3D12GraphicsCommandList_Reset(list, alloc, pipeline), "Reset(list)");
        ID3D12GraphicsCommandList_SetGraphicsRootSignature(list, rootSig);
        ID3D12GraphicsCommandList_RSSetViewports(list, 1, &vp);
        ID3D12GraphicsCommandList_RSSetScissorRects(list, 1, &sc);

        D3D12_RESOURCE_BARRIER b0 = {0};
        b0.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
        b0.Transition.pResource = targets[backIdx];
        b0.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
        b0.Transition.StateBefore = D3D12_RESOURCE_STATE_PRESENT;
        b0.Transition.StateAfter = D3D12_RESOURCE_STATE_RENDER_TARGET;
        ID3D12GraphicsCommandList_ResourceBarrier(list, 1, &b0);

        heap_start(rtvHeap, &rtv);
        rtv.ptr += backIdx * rtvSize;
        ID3D12GraphicsCommandList_OMSetRenderTargets(list, 1, &rtv, FALSE, NULL);
        ID3D12GraphicsCommandList_ClearRenderTargetView(list, rtv, clearColor, 0, NULL);
        ID3D12GraphicsCommandList_IASetPrimitiveTopology(list, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        ID3D12GraphicsCommandList_IASetVertexBuffers(list, 0, 1, &vbv);
        ID3D12GraphicsCommandList_DrawInstanced(list, 3, 1, 0, 0);

        D3D12_RESOURCE_BARRIER b1 = {0};
        b1.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
        b1.Transition.pResource = targets[backIdx];
        b1.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
        b1.Transition.StateBefore = D3D12_RESOURCE_STATE_RENDER_TARGET;
        b1.Transition.StateAfter = D3D12_RESOURCE_STATE_PRESENT;
        ID3D12GraphicsCommandList_ResourceBarrier(list, 1, &b1);

        HRF(ID3D12GraphicsCommandList_Close(list), "Close(list)");
        ID3D12CommandList* lists[1] = {(ID3D12CommandList*)list};
        ID3D12CommandQueue_ExecuteCommandLists(queue, 1, lists);
        HRF(IDXGISwapChain1_Present(sc1, 1, 0), "Present");
        { MSG msg; while (PeekMessageA(&msg, NULL, 0, 0, PM_REMOVE)) DispatchMessageA(&msg); }

        HRF(ID3D12CommandQueue_Signal(queue, fence, fenceVal), "Signal");
        if (ID3D12Fence_GetCompletedValue(fence) < fenceVal) {
            HRF(ID3D12Fence_SetEventOnCompletion(fence, fenceVal, evt), "SetEventOnCompletion");
            WaitForSingleObject(evt, 10000);
        }
        fenceVal++;
    }
    { char b[128]; wsprintfA(b, "tri12draw: %d frames drawn+presented\ntri12draw: RESULT 0\n",
                             TRI12DRAW_FRAMES); dbg(b); }
    return 0;
}
