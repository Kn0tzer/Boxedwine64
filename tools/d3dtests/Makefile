# tools/d3dtests/Makefile — build the D3D9 gate probe apps.
# x86_64-w64-mingw32-g++ (any flavor; these apps use no C++-threading features).
# Usage: make        # builds clear9.exe texquad9.exe vshade9.exe
#        make clean
CXX      = x86_64-w64-mingw32-g++
CXXFLAGS = -O2 -Wall
LDFLAGS  = -ld3d9 -lgdi32 -luser32

APPS = clear9 texquad9 vshade9
EXES = $(APPS:%=%.exe)

all: $(EXES)

%.exe: %.cpp
	$(CXX) $(CXXFLAGS) -o $@ $< $(LDFLAGS)

clean:
	rm -f $(EXES)

.PHONY: all clean
