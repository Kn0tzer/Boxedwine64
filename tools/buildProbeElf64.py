#!/usr/bin/env python3
"""Probe ELF for freshly implemented cpu64 features.

Dumps 96 result bytes to stdout via write(1):
  out[0:8]    RAX after `call func` (func ends in `ret 8**; expect 0xC0DE)
  out[8:16]   RSP after return (must equal entry RSP: ret 8 pops 8)
  out[16:32]  mem16 after equal-case CMPXCHG16B (expect AA..AA BB..BB)
  out[32:48]  RAX:RDX after UNEQUAL cmpxchg16b (expect old mem loaded)
  out[48:64]  RSQRTPS(4,9,16,2) packed singles (0.5,0.333,0.25,0.7071)
  out[64:72]  CVTSS2SD(4.0f) as double (expect 4.0)
  out[72:80]  times(NULL) return (USER_HZ ticks, expect nonzero)
  out[80:96]  zero padding

Usage: python3 tools/buildProbeElf64.py [outfile]  (default tools/testdata/probe64.elf)
"""

import struct
import sys
import os

LOAD_VADDR = 0x400000
CODE_OFF = 0x0078


class Asm:
    def __init__(self):
        self.buf = bytearray()
        self.labels = {}
        self.fixups = []  # (pos, size, label); size 1=rel8, 4=rel/disp32

    def label(self, name):
        self.labels[name] = len(self.buf)

    def hx(self, h):
        self.buf += bytes.fromhex(h)

    def qword(self, v):
        self.buf += struct.pack("<Q", v & 0xFFFFFFFFFFFFFFFF)

    def _fix(self, size, label):
        self.fixups.append((len(self.buf), size, label))
        self.buf += b"\x00" * size

    def rel8(self, label):
        self._fix(1, label)

    def rel32(self, label):
        self._fix(4, label)

    def disp32(self, label):
        self._fix(4, label)

    def resolve(self, base_vaddr):
        for pos, size, label in self.fixups:
            target = base_vaddr + self.labels[label]
            delta = target - (base_vaddr + pos + size)
            if size == 1:
                assert -128 <= delta <= 127, (label, delta)
                struct.pack_into("<b", self.buf, pos, delta)
            else:
                struct.pack_into("<i", self.buf, pos, delta)


def build():
    a = Asm()
    # _start:
    a.hx("E8");            a.rel32("func")        # call func
    a.hx("488D35");        a.disp32("out")        # lea rsi, [rip+out]
    a.hx("488906")                                # mov [rsi], rax   ; 0xC0DE?
    a.hx("48896608")                              # mov [rsi+8], rsp ; entry RSP?
    a.hx("EB");            a.rel8("t16")         # jmp t16
    a.label("func")
    a.hx("B8DEC00000")                            # mov eax, 0xC0DE
    a.hx("C20800")                                # ret 8
    a.label("t16")
    # --- CMPXCHG16B equal case ---
    a.hx("48B8");          a.qword(0x1111111111111111)  # mov rax, lo
    a.hx("48BA");          a.qword(0x2222222222222222)  # mov rdx, hi
    a.hx("48BB");          a.qword(0xAAAAAAAAAAAAAAAA)  # mov rbx, new lo
    a.hx("48B9");          a.qword(0xBBBBBBBBBBBBBBBB)  # mov rcx, new hi
    a.hx("F0480FC70D");    a.disp32("mem16")      # lock cmpxchg16b [rip+mem16]
    a.hx("488D3D");        a.disp32("mem16")      # lea rdi, [rip+mem16]
    a.hx("488B0F")                                # mov rcx, [rdi]
    a.hx("488B5708")                              # mov rdx, [rdi+8]
    a.hx("48894E10")                              # mov [rsi+16], rcx
    a.hx("48895618")                              # mov [rsi+24], rdx
    # --- CMPXCHG16B unequal case: rax:rdx=0 vs mem -> ZF=0, loads mem ---
    a.hx("31C0")                                  # xor eax, eax
    a.hx("31D2")                                  # xor edx, edx
    a.hx("F0480FC70D");    a.disp32("mem16")      # lock cmpxchg16b [rip+mem16]
    a.hx("48894620")                              # mov [rsi+32], rax
    a.hx("48895628")                              # mov [rsi+40], rdx
    # --- RSQRTPS ---
    a.hx("0F2805");        a.disp32("vec")        # movaps xmm0, [rip+vec]
    a.hx("0F52C8")                                # rsqrtps xmm1, xmm0
    a.hx("0F294E30")                              # movaps [rsi+48], xmm1
    # --- CVTSS2SD ---
    a.hx("F30F5AD0")                              # cvtss2sd xmm2, xmm0
    a.hx("F20F115640")                            # movsd [rsi+64], xmm2
    # --- times(NULL) ---
    a.hx("B864000000")                            # mov eax, 100
    a.hx("31FF")                                  # xor edi, edi
    a.hx("0F05")                                  # syscall
    a.hx("48894648")                              # mov [rsi+72], rax
    # --- write(1, out, 80) ---
    a.hx("B801000000")                            # mov eax, 1
    a.hx("BF01000000")                            # mov edi, 1
    a.hx("BA50000000")                            # mov edx, 80
    a.hx("0F05")                                  # syscall (rsi still = out)
    # --- exit(0) ---
    a.hx("B83C000000")                            # mov eax, 60
    a.hx("31FF")                                  # xor edi, edi
    a.hx("0F05")                                  # syscall
    code = bytes(a.buf)

    out_off = len(code)
    vec_off = out_off + 96
    mem_off = vec_off + 16
    total = mem_off + 16
    body = bytearray(total)
    body[0:len(code)] = code
    # out[0:96] stays zero
    body[vec_off:vec_off+16] = struct.pack("<ffff", 4.0, 9.0, 16.0, 2.0)
    body[mem_off:mem_off+16] = struct.pack("<QQ", 0x1111111111111111,
                                           0x2222222222222222)

    # fixup labels relative to code start
    a.labels["out"] = out_off
    a.labels["vec"] = vec_off
    a.labels["mem16"] = mem_off
    a.resolve(LOAD_VADDR + CODE_OFF)
    body[0:len(code)] = bytes(a.buf)

    # --- ELF header + one RWX PT_LOAD ---
    ehdr_size = 64
    phdr_size = 56
    assert CODE_OFF == ehdr_size + phdr_size
    elf = bytearray(CODE_OFF + total)
    ident = bytearray(16)
    ident[0:4] = b"\x7fELF"
    ident[4] = 2
    ident[5] = 1
    ident[6] = 1
    elf[0:16] = ident
    elf[16:64] = struct.pack("<HHIQQQIHHHHHH", 2, 0x3E, 1,
                             LOAD_VADDR + CODE_OFF, 0x40, 0, 0,
                             64, 56, 1, 0, 0, 0)
    elf[64:120] = struct.pack("<IIQQQQQQ", 1, 7, 0, LOAD_VADDR, LOAD_VADDR,
                              CODE_OFF + total, CODE_OFF + total, 0x1000)
    elf[CODE_OFF:CODE_OFF+total] = body
    return bytes(elf)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "testdata", "probe64.elf")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    blob = build()
    with open(out, "wb") as f:
        f.write(blob)
    os.chmod(out, 0o755)
    print(f"wrote {out} ({len(blob)} bytes)")


if __name__ == "__main__":
    main()
