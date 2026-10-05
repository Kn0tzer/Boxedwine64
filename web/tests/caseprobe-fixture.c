#include <windows.h>
#include <stdio.h>

// Case probe: one file on disk (MyTiny.dll); LoadLibrary with three
// spellings. Windows/Wine is case-insensitive: all three must load.
// If only the exact-case spelling loads, the browser FS / NtOpenFile path
// is case-sensitive and mixed-case app DLLs (UnityPlayer.dll) break.
static void tryLoad(FILE *out, const char *name) {
    HMODULE mod = LoadLibraryA(name);
    if (mod) {
        fprintf(out, "%s: load=ok gle=%lu\n", name, (unsigned long)GetLastError());
        FreeLibrary(mod);
    } else {
        fprintf(out, "%s: load=fail gle=%lu\n", name, (unsigned long)GetLastError());
    }
    fflush(out);
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR cmd, int show) {
    FILE *out = fopen("caseprobe-result.txt", "w");
    tryLoad(out, "MyTiny.dll");
    tryLoad(out, "mytiny.dll");
    tryLoad(out, "MYTINY.DLL");
    fprintf(out, "done\n");
    fclose(out);
    return 0;
}
