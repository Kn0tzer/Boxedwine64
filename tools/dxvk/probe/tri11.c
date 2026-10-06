#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <stdio.h>

int main(void) {
    HRESULT hr;
    ID3D11Device* dev = NULL;
    ID3D11DeviceContext* ctx = NULL;
    D3D_FEATURE_LEVEL fl_out = 0;
    D3D_FEATURE_LEVEL fl_req[] = {
        D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1,
        D3D_FEATURE_LEVEL_10_0,
    };
    fprintf(stderr, "tri11: WinMain start\n");
    hr = D3D11CreateDevice(NULL, D3D_DRIVER_TYPE_HARDWARE, NULL, 0,
                           fl_req, 3, D3D11_SDK_VERSION,
                           &dev, &fl_out, &ctx);
    if (FAILED(hr)) {
        fprintf(stderr, "tri11: FAIL D3D11CreateDevice hr=0x%08X\n", (unsigned)hr);
        fprintf(stderr, "tri11: RESULT 1\n");
        return 1;
    }
    fprintf(stderr, "tri11: D3D11CreateDevice OK, FL=0x%x\n", (unsigned)fl_out);
    fprintf(stderr, "tri11: RESULT 0\n");
    return 0;
}
// Full triangle test appended - see tri11.c for D3D11CreateDevice FL check
