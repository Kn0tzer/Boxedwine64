#include <windows.h>

__declspec(dllexport) int tiny_add(int a, int b) { return a + b; }

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID r) { return TRUE; }
