#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
static char label[256] = "missing sibling asset";
static int launches;
static LRESULT CALLBACK proc(HWND hwnd, UINT message, WPARAM w, LPARAM l) {
  if (message == WM_PAINT) {
    PAINTSTRUCT ps; HDC dc=BeginPaint(hwnd,&ps);
    TextOutA(dc,20,20,label,lstrlenA(label));
    char text[80]; wsprintfA(text,"Saved launch count: %d",launches);
    TextOutA(dc,20,55,text,lstrlenA(text)); EndPaint(hwnd,&ps); return 0;
  }
  if (message == WM_CHAR) {
    FILE *f=fopen("input.txt","ab");if(f){fputc((int)w,f);fclose(f);}return 0;
  }
  if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
  return DefWindowProcA(hwnd,message,w,l);
}
int WINAPI WinMain(HINSTANCE instance,HINSTANCE previous,LPSTR cmd,int show) {
  FILE *f=fopen("assets/message.txt","rb");if(f){size_t n=fread(label,1,255,f);label[n]=0;fclose(f);}
  f=fopen("observed.txt","wb");if(f){fprintf(f,"%s",label);fclose(f);}
  f=fopen("save.txt","r");if(f){fscanf(f,"%d",&launches);fclose(f);}launches++;
  f=fopen("save.txt","w");if(f){fprintf(f,"%d",launches);fclose(f);}
  WNDCLASSA wc={0};wc.lpfnWndProc=proc;wc.hInstance=instance;wc.lpszClassName="FolderProbe";wc.hbrBackground=(HBRUSH)(COLOR_WINDOW+1);RegisterClassA(&wc);
  CreateWindowA("FolderProbe","Folder import + sibling asset + save probe",WS_OVERLAPPEDWINDOW|WS_VISIBLE,50,50,480,240,0,0,instance,0);
  MSG msg;while(GetMessageA(&msg,0,0,0)>0){TranslateMessage(&msg);DispatchMessageA(&msg);}return 0;
}
