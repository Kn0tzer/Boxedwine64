#include <windows.h>
#include <stdio.h>

// UnityPlayer load probe: single LoadLibrary of the real 28MB Unity
// player DLL shipped with Baldi. Distinguishes loader failure (fail +
// GetLastError) from an emulator crash (no result file + unimpl opcode).
int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR cmd, int show) {
    FILE *out = fopen("playerprobe-result.txt", "w");
    HMODULE mod = LoadLibraryA("UnityPlayer.dll");
    if (mod) {
        fprintf(out, "UnityPlayer.dll: load=ok gle=%lu\n", (unsigned long)GetLastError());
        FreeLibrary(mod);
    } else {
        fprintf(out, "UnityPlayer.dll: load=fail gle=%lu\n", (unsigned long)GetLastError());
    }
    fprintf(out, "done\n");
    fclose(out);
    return 0;
}
