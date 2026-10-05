#include <windows.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <io.h>
#include <errno.h>
#include <stdio.h>

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR cmd, int show) {
    FILE *out = fopen("stat-result.txt", "w");
    int fd = _open("assets/message.txt", _O_RDONLY | _O_BINARY);
    struct _stat32 s32 = {0};
    struct _stat64 s64 = {0};
    errno = 0;
    int r32 = _fstat32(fd, &s32), e32 = errno;
    errno = 0;
    int r64 = _fstat64(fd, &s64), e64 = errno;
    fprintf(out, "stat32=%d errno=%d size=%ld mtime=%lld\nstat64=%d errno=%d size=%lld mtime=%lld\n",
            r32, e32, (long)s32.st_size, (long long)s32.st_mtime,
            r64, e64, (long long)s64.st_size, (long long)s64.st_mtime);
    fclose(out);
    _close(fd);
    return r32 || r64;
}
