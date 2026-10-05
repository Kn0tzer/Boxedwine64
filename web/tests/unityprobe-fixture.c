#include <windows.h>
#include <stdio.h>

static void tryLoad(FILE *out, const char *name) {
    HMODULE mod = LoadLibraryA(name);
    if (mod) {
        fprintf(out, "%s: load=ok handle=%p gle=%lu\n", name, (void*)mod, (unsigned long)GetLastError());
        FreeLibrary(mod);
    } else {
        fprintf(out, "%s: load=fail gle=%lu\n", name, (unsigned long)GetLastError());
    }
    fflush(out);
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR cmd, int show) {
    FILE *out = fopen("unityprobe-result.txt", "w");
    tryLoad(out, "MyTiny.dll");
    tryLoad(out, "UnityPlayer.dll");
    tryLoad(out, "unityplayer.dll");
    fprintf(out, "done\n");
    fclose(out);
    return 0;
}
