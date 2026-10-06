/*
 * tri9pong.c — G2 validation app: D3D9 Pong through DXVK.
 *
 * A minimal but real game on the proven D3D9 path (Direct3DCreate9,
 * CreateDevice with SOFTWARE_VERTEXPROCESSING, DrawPrimitiveUP quads,
 * D3DPRESENT_INTERVAL_IMMEDIATE — the same shape as tri9input.c that
 * already proved 43k lit pixels + input causality).
 *
 * Gameplay: right paddle = player (Up/Down arrows), left paddle = AI.
 * Ball bounces off top/bottom and paddles; a point scores when the ball
 * passes a paddle. Ball speed increases slightly on each paddle hit so
 * the AI (slower than max ball speed) eventually misses.
 *
 * Machine-readable diagnostics on stderr (mirrors tri9input's style so
 * existing probe parsers need no changes):
 *   tri9pong: KEYDOWN vk=0x.. keys=N      (each key press, input causality)
 *   tri9pong: point L|R score L-R        (each score)
 *   tri9pong: frame N score L-R ball (x,y)
 *   tri9pong: RESULT 0 / RESULT 1 + reason
 *
 * Build (mingw-w64):
 *   x86_64-w64-mingw32-gcc -O2 -o tri9pong.exe tri9pong.c -ld3d9 -lgdi32 -luser32
 */
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d9.h>
#include <stdio.h>

#define PONG_FRAMES 1800
#define PONG_W 480
#define PONG_H 360
#define WIN_SCORE 5

static void dbg(const char* s) {
    fprintf(stderr, "%s", s); fflush(stderr);
    OutputDebugStringA(s);
}
#define FAIL(...) do { char b[256]; wsprintfA(b, __VA_ARGS__); dbg(b); \
    dbg("tri9pong: RESULT 1\n"); return 1; } while (0)

typedef struct { float x, y, z, rhw; DWORD color; } CUSTOMVERTEX;
#define D3DFVF_CUSTOMVERTEX (D3DFVF_XYZRHW | D3DFVF_DIFFUSE)

/* ---- game state ---- */
#define PADDLE_W 12.0f
#define PADDLE_H 64.0f
#define BALL_S 10.0f
#define PL_X 18.0f
#define PR_X (PONG_W - 18.0f - PADDLE_W)
#define PADDLE_SPEED 5.0f
#define AI_SPEED 2.7f

static float g_pl = 148.0f;   /* left (AI) paddle top */
static float g_pr = 148.0f;   /* right (player) paddle top */
static float g_bx = 240.0f, g_by = 180.0f;
static float g_vx = 3.0f, g_vy = 1.5f;
static int g_scoreL = 0, g_scoreR = 0;
static int g_keyUp = 0, g_keyDown = 0, g_keys = 0;

static void resetBall(int dir) {
    g_bx = PONG_W / 2.0f; g_by = PONG_H / 2.0f;
    g_vx = (dir > 0) ? 3.0f : -3.0f;
    g_vy = 1.5f;
}

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_KEYDOWN || m == WM_KEYUP) {
        int dn = (m == WM_KEYDOWN);
        char b[128];
        switch (w) {
        case VK_UP:   g_keyUp = dn; break;
        case VK_DOWN: g_keyDown = dn; break;
        case VK_ESCAPE: if (dn) PostQuitMessage(0); return 0;
        default: break;
        }
        if (dn) {
            g_keys++;
            wsprintfA(b, "tri9pong: KEYDOWN vk=0x%02lx keys=%d\n",
                      (unsigned long)w, g_keys);
            dbg(b);
        }
        return 0;
    }
    if (m == WM_CLOSE || m == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProc(h, m, w, l);
}

/* append a two-triangle quad to the vertex list, returns verts written (6) */
static void quad(CUSTOMVERTEX* v, float x, float y, float w, float h, DWORD c) {
    v[0].x = x;     v[0].y = y;     v[0].z = 0.5f; v[0].rhw = 1.0f; v[0].color = c;
    v[1].x = x + w; v[1].y = y;     v[1].z = 0.5f; v[1].rhw = 1.0f; v[1].color = c;
    v[2].x = x;     v[2].y = y + h; v[2].z = 0.5f; v[2].rhw = 1.0f; v[2].color = c;
    v[3].x = x + w; v[3].y = y;     v[3].z = 0.5f; v[3].rhw = 1.0f; v[3].color = c;
    v[4].x = x + w; v[4].y = y + h; v[4].z = 0.5f; v[4].rhw = 1.0f; v[4].color = c;
    v[5].x = x;     v[5].y = y + h; v[5].z = 0.5f; v[5].rhw = 1.0f; v[5].color = c;
}

static float clampf(float v, float lo, float hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

static void step(void) {
    /* player paddle */
    if (g_keyUp)   g_pr -= PADDLE_SPEED;
    if (g_keyDown) g_pr += PADDLE_SPEED;
    g_pr = clampf(g_pr, 0.0f, PONG_H - PADDLE_H);

    /* AI paddle: chase the ball only while it comes at us */
    {
        float target = (g_vx < 0.0f) ? (g_by - PADDLE_H / 2.0f) : (PONG_H - PADDLE_H) / 2.0f;
        float d = target - g_pl;
        if (d > AI_SPEED) d = AI_SPEED;
        else if (d < -AI_SPEED) d = -AI_SPEED;
        g_pl = clampf(g_pl + d, 0.0f, PONG_H - PADDLE_H);
    }

    /* ball */
    g_bx += g_vx;
    g_by += g_vy;
    if (g_by < 0.0f)        { g_by = 0.0f; g_vy = -g_vy; }
    if (g_by + BALL_S > PONG_H) { g_by = PONG_H - BALL_S; g_vy = -g_vy; }

    /* paddle collisions */
    if (g_vx < 0.0f && g_bx <= PL_X + PADDLE_W && g_bx + BALL_S >= PL_X &&
        g_by + BALL_S >= g_pl && g_by <= g_pl + PADDLE_H) {
        float hit = (g_by + BALL_S / 2.0f - (g_pl + PADDLE_H / 2.0f)) / (PADDLE_H / 2.0f);
        g_vx = -(g_vx - 0.25f);            /* speed up slightly */
        if (g_vx > 6.0f) g_vx = 6.0f;
        g_vy = hit * 3.0f;
        g_bx = PL_X + PADDLE_W;
    }
    if (g_vx > 0.0f && g_bx + BALL_S >= PR_X && g_bx <= PR_X + PADDLE_W &&
        g_by + BALL_S >= g_pr && g_by <= g_pr + PADDLE_H) {
        float hit = (g_by + BALL_S / 2.0f - (g_pr + PADDLE_H / 2.0f)) / (PADDLE_H / 2.0f);
        g_vx = -(g_vx + 0.25f);
        if (g_vx < -6.0f) g_vx = -6.0f;
        g_vy = hit * 3.0f;
        g_bx = PR_X - BALL_S;
    }

    /* scoring */
    if (g_bx < -BALL_S) {
        g_scoreR++;
        { char b[96]; wsprintfA(b, "tri9pong: point R score %d-%d\n", g_scoreL, g_scoreR); dbg(b); }
        resetBall(-1);
    } else if (g_bx > PONG_W) {
        g_scoreL++;
        { char b[96]; wsprintfA(b, "tri9pong: point L score %d-%d\n", g_scoreL, g_scoreR); dbg(b); }
        resetBall(1);
    }
}

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR cmd, int show) {
    IDirect3D9* d3d = NULL;
    IDirect3DDevice9* dev = NULL;
    HWND hwnd;
    WNDCLASSA wc = {0};
    D3DPRESENT_PARAMETERS pp;
    MSG msg;
    int frames = 0;
    (void)hPrev; (void)cmd; (void)show;

    dbg("tri9pong: WinMain start (D3D9 Pong)\\n");

    wc.lpfnWndProc = WndProc;
    wc.hInstance = hInst;
    wc.lpszClassName = "tri9pong";
    RegisterClassA(&wc);
    hwnd = CreateWindowA("tri9pong", "Boxedwine64 DXVK Pong",
                         WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                         CW_USEDEFAULT, CW_USEDEFAULT, PONG_W, PONG_H,
                         0, 0, hInst, 0);
    if (!hwnd) FAIL("tri9pong: FAIL CreateWindow\\n");

    d3d = Direct3DCreate9(D3D_SDK_VERSION);
    if (!d3d) FAIL("tri9pong: FAIL Direct3DCreate9 returned NULL\\n");

    ZeroMemory(&pp, sizeof(pp));
    pp.Windowed = TRUE;
    pp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    pp.BackBufferWidth = PONG_W;
    pp.BackBufferHeight = PONG_H;
    pp.BackBufferFormat = D3DFMT_X8R8G8B8;
    pp.EnableAutoDepthStencil = FALSE;
    pp.PresentationInterval = D3DPRESENT_INTERVAL_IMMEDIATE;

    if (FAILED(IDirect3D9_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            hwnd, D3DCREATE_SOFTWARE_VERTEXPROCESSING, &pp, &dev)))
        FAIL("tri9pong: FAIL CreateDevice HAL\\n");
    dbg("tri9pong: device created OK\\n");

    IDirect3DDevice9_SetRenderState(dev, D3DRS_LIGHTING, FALSE);
    IDirect3DDevice9_SetRenderState(dev, D3DRS_CULLMODE, D3DCULL_NONE);
    resetBall(1);

    for (;;) {
        CUSTOMVERTEX v[24];
        while (PeekMessageA(&msg, 0, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) goto done;
            TranslateMessage(&msg);
            DispatchMessageA(&msg);
        }

        step();

        IDirect3DDevice9_Clear(dev, 0, NULL, D3DCLEAR_TARGET,
            D3DCOLOR_XRGB(8, 24, 64), 1.0f, 0);
        if (SUCCEEDED(IDirect3DDevice9_BeginScene(dev))) {
            /* net, left paddle, right paddle, ball */
            quad(v + 0,  (PONG_W - 2.0f) / 2.0f, 8.0f, 2.0f, PONG_H - 16.0f, 0xff335577);
            quad(v + 6,  PL_X, g_pl, PADDLE_W, PADDLE_H, 0xffeeeeee);
            quad(v + 12, PR_X, g_pr, PADDLE_W, PADDLE_H, 0xffeeeeee);
            quad(v + 18, g_bx, g_by, BALL_S, BALL_S, 0xffffffff);
            IDirect3DDevice9_SetFVF(dev, D3DFVF_CUSTOMVERTEX);
            IDirect3DDevice9_DrawPrimitiveUP(dev, D3DPT_TRIANGLELIST, 8, v,
                                             sizeof(CUSTOMVERTEX));
            IDirect3DDevice9_EndScene(dev);
        }
        IDirect3DDevice9_Present(dev, NULL, NULL, NULL, NULL);
        frames++;
        if (frames == 1) dbg("tri9pong: first Present DONE\\n");
        if (frames % 300 == 0) {
            char b[96];
            wsprintfA(b, "tri9pong: frame %d score %d-%d ball (%d,%d)\\n",
                      frames, g_scoreL, g_scoreR, (int)g_bx, (int)g_by);
            dbg(b);
        }
        if (g_scoreL >= WIN_SCORE || g_scoreR >= WIN_SCORE) break;
        if (frames >= PONG_FRAMES) break;
        Sleep(16);
    }
done:
    if (dev) IDirect3DDevice9_Release(dev);
    if (d3d) IDirect3D9_Release(d3d);
    { char b[96]; wsprintfA(b, "tri9pong: %d frames final score %d-%d\\ntri9pong: RESULT 0\\n",
                            frames, g_scoreL, g_scoreR); dbg(b); }
    return 0;
}
