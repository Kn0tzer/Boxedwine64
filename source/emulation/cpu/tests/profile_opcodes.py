#!/usr/bin/env python3
"""profile_opcodes.py - static opcode frequency profile of x86-64 PE binaries.

Evidence generator for the phase-1 JIT top-20 opcode coverage table
(include/jit64.h: jit64CoveredOpcodes). Parses PE files, extracts executable
sections, disassembles with capstone, and counts instructions by primary
opcode byte AFTER legacy/REX prefixes (the same normalization the JIT
decoder in source/emulation/cpu/jit64.cpp uses: e.g. `48 89 C8` counts as
opcode 89, `0F 84 ..` counts as 0F84).

Only 64-bit PEs (COFF machine 0x8664) are accepted; anything else is
skipped with a note (decoding x86-32 as x86-64 would corrupt the profile).

Usage:
    python3 profile_opcodes.py <exe> [<exe> ...]

Requires: pip install capstone
"""

import struct
import sys

LEGACY_PREFIXES = {0xF0, 0xF2, 0xF3, 0x2E, 0x36, 0x3E, 0x26, 0x64, 0x65, 0x66, 0x67}


def is_rex(b):
    return (b & 0xF0) == 0x40


def opcode_key(raw: bytes) -> str:
    """Normalize raw instruction bytes to an opcode key like '89' or '0F84'."""
    i = 0
    while i < len(raw) and (raw[i] in LEGACY_PREFIXES or is_rex(raw[i])):
        i += 1
    if i >= len(raw):
        return "??"
    op = raw[i]
    if op == 0xC4 or op == 0xC5:  # VEX prefix
        return "VEX"
    if op == 0x62:  # EVEX prefix
        return "EVEX"
    if op == 0x0F:
        if i + 1 >= len(raw):
            return "0F??"
        op2 = raw[i + 1]
        if op2 == 0x38 or op2 == 0x3A:
            return "0F%02X" % op2  # 3-byte form, bucket by map
        return "0F%02X" % op2
    return "%02X" % op


def pe_exec_sections(path: str):
    """Yield (name, raw_bytes) for executable sections of a 64-bit PE file."""
    with open(path, "rb") as f:
        data = f.read()
    if data[0:2] != b"MZ":
        raise ValueError("not a PE file")
    e_lfanew = struct.unpack_from("<I", data, 0x3C)[0]
    if data[e_lfanew:e_lfanew + 4] != b"PE\0\0":
        raise ValueError("bad PE signature")
    coff = e_lfanew + 4
    machine = struct.unpack_from("<H", data, coff)[0]
    if machine != 0x8664:
        raise ValueError("not x86-64 (machine=%04x)" % machine)
    num_sections = struct.unpack_from("<H", data, coff + 2)[0]
    opt_size = struct.unpack_from("<H", data, coff + 16)[0]
    sectab = coff + 20 + opt_size
    out = []
    for s in range(num_sections):
        off = sectab + s * 40
        name = data[off:off + 8].split(b"\0")[0].decode("ascii", "replace")
        raw_size = struct.unpack_from("<I", data, off + 16)[0]
        raw_ptr = struct.unpack_from("<I", data, off + 20)[0]
        chars = struct.unpack_from("<I", data, off + 36)[0]
        if chars & 0x20000000:  # IMAGE_SCN_MEM_EXECUTE
            out.append((name, data[raw_ptr:raw_ptr + raw_size]))
    return out


# Opcode keys with a JIT fast path, verified against the decoder
# (jit64.cpp), classifier, and emitter. POP/PUSH register rows and MOV r,imm
# are counted as classes (58..5F, 50..57, B8..BF); NOP padding (90, 0F1F) is
# excluded from the profile.
#   ALU r/m,r + r,r/m: the whole 00..3B range ((op&6)!=6, (op&7)<=3)
#   ALU acc,imm: 04..3D step 8, plus A8/A9 (TEST acc,imm, sub 8)
#   ALU r/m,imm: 80/81/83; TEST r/m,r: 84/85
#   MOV: 88/89/8A/8B, B8..BF, C7; MOVZX/MOVSX: 0FB6/0FB7/0FBE/0FBF; MOVSXD: 63
#   IMUL: 0FAF (2-op, reg-direct), 69/6B (3-op, reg-direct); mem forms fall back
#   Control flow (decoded + classified fast; they terminate blocks by design):
#   JMP rel8 (EB), Jcc rel8 (70..7F), Jcc rel32 (0F80..0F8F)
COVERED = {
    "89", "8B", "83", "8D", "E8", "85", "E9", "31", "74", "39",
    "0F84", "C7", "75", "C3", "0F85", "01", "C1", "0FB6", "58..5F", "29",
    "50..57", "B8..BF", "63",
    "F6", "F7", "98", "D0", "D1", "99", "C6", "D2", "D3",
    "AB", "C0",
    "A4", "A5", "A6", "A7", "AA", "AE", "AF",
    "69", "6B", "0FAF",
    "00", "02", "03", "08", "09", "0A", "0B", "10", "11", "12", "13",
    "18", "19", "1A", "1B", "20", "21", "22", "23", "28", "2A", "2B",
    "30", "32", "33", "38", "3A", "3B",
    "04", "05", "0C", "0D", "14", "15", "1C", "1D", "24", "25",
    "2C", "2D", "34", "35", "3C", "3D", "A8", "A9",
    "80", "81", "84",
    "88", "8A",
    "0FB7", "0FBE", "0FBF",
    "EB",
    "70", "71", "72", "73", "76", "77", "78", "79", "7A", "7B",
    "7C", "7D", "7E", "7F",
    "0F40", "0F41", "0F42", "0F43", "0F44", "0F45", "0F46", "0F47", "0F48", "0F49", "0F4A", "0F4B", "0F4C", "0F4D", "0F4E", "0F4F", "0F80", "0F81", "0F82", "0F83", "0F86", "0F87", "0F88", "0F89",
    "0F8A", "0F8B", "0F8C", "0F8D", "0F8E", "0F8F",
    "0F90", "0F91", "0F92", "0F93", "0F94", "0F95", "0F96", "0F97", "0F98", "0F99", "0F9A", "0F9B", "0F9C", "0F9D", "0F9E", "0F9F",
    "0FA3", "0FAB", "0FB3", "0FBB",
}


def main(paths):
    from capstone import Cs, CS_ARCH_X86, CS_MODE_64
    md = Cs(CS_ARCH_X86, CS_MODE_64)
    md.skipdata = True
    counts = {}
    total = 0
    per_file = {}
    for path in paths:
        try:
            sections = pe_exec_sections(path)
        except ValueError as e:
            print("skip %s: %s" % (path, e))
            continue
        n_file = 0
        for name, code in sections:
            for insn in md.disasm(code, 0x140000000):
                key = opcode_key(insn.bytes)
                counts[key] = counts.get(key, 0) + 1
                total += 1
                n_file += 1
        per_file[path] = n_file
    raw_total = total  # includes NOP padding (for share denominators)
    print("NOP padding excluded from ranking: 90=%d, 0F1F=%d" % (
        counts.get("90", 0), counts.get("0F1F", 0)))
    # Normalization matching this script's docstring and jit64.cpp's kCovered
    # table: NOP padding (90, 0F1F) is excluded, and the PUSH/POP register
    # rows (50..57, 58..5F) plus MOV r,imm (B8..BF) are grouped into classes
    # (the JIT treats each row of a class identically).
    def class_key(key):
        try:
            b = int(key, 16)
        except ValueError:
            return key
        if 0x58 <= b <= 0x5F:
            return "58..5F"
        if 0x50 <= b <= 0x57:
            return "50..57"
        if 0xB8 <= b <= 0xBF:
            return "B8..BF"
        return key
    norm = {}
    for key, c in counts.items():
        if key in ("90", "0F1F"):
            continue  # NOP padding excluded
        g = class_key(key)
        norm[g] = norm.get(g, 0) + c
    counts = norm
    total = sum(counts.values())
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])
    print("files:")
    for path, n in per_file.items():
        print("  %-60s %7d insns" % (path, n))
    print("total instructions: %d" % total)
    print()
    print("rank  opcode  count      share  cum%   jit-fast?")
    cum = 0
    covered_share = 0.0
    for rank, (key, c) in enumerate(ranked[:25], 1):
        share = 100.0 * c / total
        cum += share
        fast = "yes" if key in COVERED else "-"
        if key in COVERED:
            covered_share += share
        print("%2d    %-6s %7d  %6.2f%%  %6.2f%%  %s" % (rank, key, c, share, cum, fast))
    print()
    print("top-20 opcode share of all instructions: %.2f%%" % (100.0 * sum(c for _, c in ranked[:20]) / total))
    print("share covered by phase-1 JIT fast set:   %.2f%%" % covered_share)
    print()
    print("top-20 FAST-SET opcodes (the phase-1 coverage table; shares are of")
    print("all %d instructions including padding, matching jit64.cpp kCovered):" % raw_total)
    fast_ranked = [(k, c) for k, c in ranked if k in COVERED][:20]
    fast_sum = 0
    for rank, (key, c) in enumerate(fast_ranked, 1):
        share = 100.0 * c / raw_total
        fast_sum += c
        print("%2d    %-6s %7d  %6.2f%%" % (rank, key, c, share))
    print("fast-set top-20 share of all instructions: %.2f%%" % (100.0 * fast_sum / raw_total))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: profile_opcodes.py <exe> [<exe> ...]")
    main(sys.argv[1:])
