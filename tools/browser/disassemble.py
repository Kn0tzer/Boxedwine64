import sys
import struct
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent / 'disasm'))
from capstone import Cs, CS_ARCH_X86, CS_MODE_64
p = Path(sys.argv[1]).read_bytes()
pe = struct.unpack_from('<I', p, 60)[0]
n = struct.unpack_from('<H', p, pe + 6)[0]
optlen = struct.unpack_from('<H', p, pe + 20)[0]
base = struct.unpack_from('<Q', p, pe + 24 + 24)[0]
start = int(sys.argv[2], 0)
size = int(sys.argv[3], 0) if len(sys.argv) > 3 else 512
for i in range(n):
    sec = pe + 24 + optlen + i * 40
    vs, va, rs, rp = struct.unpack_from('<IIII', p, sec + 8)
    if va <= start < va + max(vs, rs):
        off = rp + start - va
        for ins in Cs(CS_ARCH_X86, CS_MODE_64).disasm(p[off:off+size], base + start):
            print(f'{ins.address-base:08x}  {ins.bytes.hex():24} {ins.mnemonic:8} {ins.op_str}')
        break
