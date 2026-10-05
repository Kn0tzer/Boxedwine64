#include <windows.h>
#include <stdio.h>

// Minimal crypt32 repro: LoadLibrary the PE crypt32 (pulls the unix
// crypt32.so whose .bss callback table was found zeroed during the
// UnityPlayer load). Progress goes to stdout (guest fd 1 is tee'd to the
// browser console) AND to the result file, so a silent early exit is
// distinguishable from a write-path problem.
static void tryLoad(FILE *out, const char *name) {
    printf("trying %s\n", name); fflush(stdout);
    HMODULE mod = LoadLibraryA(name);
    printf("load %s -> %p gle=%lu\n", name, (void*)mod, (unsigned long)GetLastError()); fflush(stdout);
    if (mod) {
        FARPROC p = GetProcAddress(mod, "CertOpenStore");
        printf("certopenstore=%p\n", (void*)p); fflush(stdout);
        fprintf(out, "%s: load=ok certopenstore=%p gle=%lu\n", name, (void*)p, (unsigned long)GetLastError());
        FreeLibrary(mod);
    } else {
        fprintf(out, "%s: load=fail gle=%lu\n", name, (unsigned long)GetLastError());
    }
    fflush(out);
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR cmd, int show) {
    printf("cryptprobe starting\n"); fflush(stdout);
    FILE *out = fopen("cryptprobe-result.txt", "w");
    printf("fopen -> %p\n", (void*)out); fflush(stdout);
    if (!out) return 2;
    tryLoad(out, "crypt32.dll");
    fprintf(out, "done\n");
    fclose(out);
    printf("cryptprobe done\n"); fflush(stdout);
    return 0;
}
