/* deskpin.exe — Boxedwine boot-reliability helper (M18).
 *
 * wineserver closes an "empty" desktop (only explorer's own threads left as
 * users) after ONE second (server/winstation.c close_desktop_timeout). Under
 * Boxedwine's interpreted CPU the wineboot-chain -> app handoff routinely
 * leaves the desktop empty for many seconds, so explorer /desktop got
 * WM_CLOSE mid-boot and the late-arriving app found no desktop (~1-in-3 cold
 * boots died this way; explorer exiting cleanly ~51s in was the signature).
 *
 * This helper simply holds a hidden top-level window on the Default desktop
 * and sleeps forever — it is a desktop *user*, so the desktop's user count
 * never drops to explorer-only and the close timeout never arms. Zero CPU
 * cost, all wine binaries stay stock.
 *
 * Three hard-won lessons encoded below (Oct 2026 diagnostics):
 *  1. RETRY window creation. deskpin is spawned early in boot, before
 *     winex11.drv/explorer are reliably up; the first CreateWindowExA often
 *     fails with nodrv_CreateWindow ("The explorer process failed to start").
 *     Exiting then defeats the whole purpose — so retry for up to 10 min.
 *  2. Do NOT pump messages. A blocking GetMessage loop terminates this
 *     process within seconds under Boxedwine (diagnosed via pid-tagged
 *     builds: window+GetMessage dies via exit_group(0),
 *     window+Sleep lives). The hidden window needs no input processing; its
 *     existence pins the desktop, so Sleep-forever is correct and sufficient.
 *  3. Use SHORT sleeps with periodic activity. A tight Sleep(60000) loop
 *     exits under Boxedwine (diagnosed Oct 2026); window + Sleep(30000)
 *     with periodic OutputDebugString survives 180s+. The logging keeps the
 *     thread visibly active to the scheduler.
 *
 * Build: x86_64-w64-mingw32-gcc -O2 -mwindows -o deskpin.exe deskpin.c
 * The launcher spawns it right after the session comes up (wine64-launcher.js).
 */
#include <windows.h>
#include <stdio.h>

static LRESULT CALLBACK wndProc(HWND h, UINT m, WPARAM w, LPARAM l)
{
    /* Never participate in shutdown-by-close; only an explicit kill ends us. */
    if (m == WM_CLOSE) return 0;
    return DefWindowProcA(h, m, w, l);
}

int WINAPI WinMain(HINSTANCE inst, HINSTANCE prev, LPSTR cmd, int show)
{
    WNDCLASSA wc = {0};
    HWND hw = NULL;
    int i;
    char buf[128];

    (void)prev; (void)cmd; (void)show;
    wc.lpfnWndProc = wndProc;
    wc.hInstance = inst;
    wc.lpszClassName = "BoxedwineDeskPin";
    if (!RegisterClassA(&wc)) return 1;
    /* Hidden (never shown, never mapped) — just a desktop user.
     * Retry: the window driver may not be up yet (see header). */
    for (i = 0; i < 600 && !hw; i++) {
        hw = CreateWindowExA(0, wc.lpszClassName, "deskpin", WS_OVERLAPPED,
                             0, 0, 1, 1, NULL, NULL, inst, NULL);
        if (!hw) Sleep(1000);
    }
    /* Sleep forever with periodic activity (see header NOTE 3).
     * Even if the window could not be created (e.g. novideo headless),
     * exiting would drop the desktop user count and arm the close timeout. */
    i = 0;
    for (;;) {
        Sleep(30000);
        /* Periodic heartbeat: keeps the thread active under Boxedwine. */
        wsprintfA(buf, "deskpin: alive %d (hw=%p)\n", i++, hw);
        OutputDebugStringA(buf);
    }
    return 0;
}
