// tools/spirvfix/spirvfix.mjs — SPIR-V pre-pass for naga's spv-in front end.
//
// WHAT: a SPIR-V binary rewriter (pure ESM, no imports — runs in node AND in
// the page) that rewrites the module patterns naga 30.2.0 rejects, before
// web/shader.mjs hands the bytes to translate({from:'spirv',...}).
//
// WHY (root causes, tasks/p1-final.md §2.12; verified against the corpus in
// testdata/spirv via tools/spirvfix/gate.mjs):
//   R1 "split-combined-sampler": naga's lookup_sampled_image table has exactly
//      one writer — parse_image_couple, reached only from OpSampledImage. A
//      module that declares a UniformConstant of OpTypeSampledImage (glslang's
//      shape for `uniform sampler2D`) and OpLoads it straight into an
//      OpImageSample* fails with InvalidId(<the load id>) (vkcube's cube.frag:
//      InvalidId(40); corpus frags: InvalidId(14/28/34)). Rewrite: split each
//      combined uniform into image + sampler uniforms, and replace every
//      SampledImage OpLoad with image-load + sampler-load + OpSampledImage
//      (naga's own dialect).
//   R2 "fold-spec-constants": naga rejects OpSpecConstantOp
//      (UnsupportedInstruction(Type, SpecConstantOp); corpus p4). Rewrite:
//      replace every OpSpecConstant* with an equivalent OpConstant* holding
//      the DEFAULT value, folding SpecConstantOp transitively (scalar and
//      vector int/uint/float/bool ALU + composites). Non-default
//      specialization values are baked — documented: the page tier has no
//      specialization API, so defaults are the only values that could ever
//      reach the GPU here.
//
// Interface: applySpirvFix(bytes: Uint8Array) -> { bytes, applied, log }.
// applied is [] when the module needs nothing (byte-identical passthrough).
// Idempotent: a second run finds no combined loads and no spec ops.

// --- opcode numbers (Khronos SPIR-V headers, unified1) ----------------------
const Op = {
  Name: 5, MemberName: 6, ExtInstImport: 10, MemoryModel: 14, EntryPoint: 15,
  ExecutionMode: 16,
  TypeVoid: 19, TypeBool: 20, TypeInt: 21, TypeFloat: 22, TypeVector: 23,
  TypeMatrix: 24, TypeImage: 25, TypeSampler: 26, TypeSampledImage: 27,
  TypeArray: 28, TypeRuntimeArray: 29, TypeStruct: 30, TypePointer: 32,
  TypeFunction: 33,
  ConstantTrue: 41, ConstantFalse: 42, Constant: 43, ConstantComposite: 44,
  ConstantSampler: 45, ConstantNull: 46,
  SpecConstantTrue: 48, SpecConstantFalse: 49, SpecConstant: 50,
  SpecConstantComposite: 51, SpecConstantOp: 52,
  Function: 54, FunctionParameter: 55, FunctionEnd: 56, FunctionCall: 57,
  Variable: 59, Load: 61, Store: 62, AccessChain: 65,
  Decorate: 71, MemberDecorate: 72, GroupDecorate: 74,
  SampledImage: 86,
  ImageSampleImplicitLod: 87, ImageSampleExplicitLod: 88,
  ImageSampleDrefImplicitLod: 89, ImageSampleDrefExplicitLod: 90,
  ImageSampleProjImplicitLod: 91, ImageSampleProjExplicitLod: 92,
  ImageGather: 96, ImageDrefGather: 97,
  CompositeExtract: 81, CopyObject: 83,
  Select: 169, Label: 248,
};
// opcodes whose instruction words start with (result-type, result-id).
// Verified against tools/dxvk/src/include/spirv/include/spirv/unified1/spirv.h:
// result-less opcodes (Store 62, CopyMemory 63/64, ImageWrite 99, ConvertFToS
// 110 HAS a result, EmitVertex 218-221, barriers 224/225, AtomicStore 228,
// control-flow 246-253, ...) are excluded. Unknown opcodes default to
// result-less: framing always uses the word count, so attribution can only
// ever miss analysis input, never misalign the stream.
const HAS_TYPE_ID = new Set([12, 41, 42, 43, 44, 46, 48, 49, 50, 51, 52, 54, 55, 57, 59, 60,
  61, 65, 66, 67, 68, 69, 70, 77, 78, 79, 80, 81, 82, 83, 84, 86]);
for (let op = 87; op <= 251; op++) {
  if (![99, 218, 219, 220, 221, 224, 225, 228, 246, 247, 248, 249, 250, 251,
        252, 253, 255, 256, 257, 258].includes(op)) HAS_TYPE_ID.add(op);
}
// opcodes with a result-id but no result-type (labels; untyped type decls)
const HAS_ID_ONLY = new Set([19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
  31, 32, 33, 45, 248]);
const Dec = { SpecId: 1, Binding: 33, DescriptorSet: 34 };
const SC = { UniformConstant: 0, Function: 7 };

// --- module model ------------------------------------------------------------
export function parseSpirv(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 20 || bytes.length % 4 !== 0)
    throw new Error('spirvfix: not a SPIR-V byte buffer');
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  if (words[0] !== 0x07230203) throw new Error('spirvfix: bad SPIR-V magic');
  const header = { magic: words[0], version: words[1], generator: words[2], bound: words[3], schema: words[4] };
  const insns = [];
  let at = 5;
  while (at < words.length) {
    const w = words[at], wc = w >>> 16, op = w & 0xffff;
    if (wc < 1 || at + wc > words.length) throw new Error('spirvfix: truncated instruction at word ' + at);
    const operands = Array.from(words.subarray(at + 1, at + wc));
    let resultType = null, resultId = null;
    if (HAS_TYPE_ID.has(op) && operands.length >= 2) { resultType = operands[0]; resultId = operands[1]; }
    else if (HAS_ID_ONLY.has(op) && operands.length >= 1) { resultId = operands[0]; }
    insns.push({ op, words: operands, resultType, resultId });
    at += wc;
  }
  return { header, insns };
}

export function serializeSpirv(mod) {
  let n = 5;
  for (const i of mod.insns) n += 1 + i.words.length;
  const out = new Uint32Array(n);
  out[0] = mod.header.magic; out[1] = mod.header.version;
  out[2] = mod.header.generator; out[3] = mod.header.bound; out[4] = mod.header.schema;
  let at = 5;
  for (const i of mod.insns) {
    out[at++] = ((i.words.length + 1) << 16) + i.op;
    for (const w of i.words) out[at++] = w >>> 0;
  }
  return new Uint8Array(out.buffer);
}

function strOf(insn, from) {
  const bs = [];
  for (let k = from; k < insn.words.length; k++) {
    let w = insn.words[k];
    for (let b = 0; b < 4; b++) { const c = w & 0xff; if (c === 0) return bs; bs.push(c); w >>>= 8; }
  }
  return bs;
}
function strWords(s) {
  const bs = [...s].map(c => c.charCodeAt(0) & 0xff);
  bs.push(0);
  while (bs.length % 4) bs.push(0);
  const out = [];
  for (let k = 0; k < bs.length; k += 4)
    out.push((bs[k] | (bs[k + 1] << 8) | (bs[k + 2] << 16) | (bs[k + 3] << 24)) >>> 0);
  return out;
}
function decodeStr(insn) {
  let s = '';
  for (const b of strOf(insn, 1)) s += String.fromCharCode(b);
  return s;
}

// Ids for a rewrite round start at the header bound, which by spec exceeds
// every id already used — no scanning needed.
function makeIdSource(mod) {
  let next = mod.header.bound;
  return () => {
    const id = next++;
    mod.header.bound = next;
    return id;
  };
}

// Logical-layout section boundaries (SPIR-V §2.4). Only the pre-function
// prefix is scanned: OpExtInst (12) also appears inside function bodies
// (GLSL.std.450 ALU) and must not move the debug/annotation anchors.
function sections(mod) {
  let firstFunc = -1;
  mod.insns.forEach((ins, idx) => {
    if (ins.op === Op.Function && firstFunc < 0) firstFunc = idx;
  });
  const end = firstFunc < 0 ? mod.insns.length : firstFunc;
  let lastDebug = -1, lastAnnot = -1;
  for (let idx = 0; idx < end; idx++) {
    const op = mod.insns[idx].op;
    if ((op >= 3 && op <= 10) || op === 12) lastDebug = idx;
    else if (op === Op.Decorate || op === Op.MemberDecorate) lastAnnot = idx;
  }
  return { lastDebug, lastAnnot, firstFunc };
}
// --- R1: split combined SampledImage uniforms -------------------------------
// A UniformConstant variable of OpTypeSampledImage becomes an image uniform
// (same set/binding) plus a sampler uniform (same set, first free binding).
// Every function-body OpLoad of SampledImage type is replaced in place by
// image-load + sampler-load + OpSampledImage, reusing the old result id so
// all consumers (implicit/explicit LOD, bias, grad, Proj, Dref, Gather) work
// untouched. Returns true when anything changed.
export function splitCombinedSamplers(mod, log) {
  const byId = new Map();
  for (const ins of mod.insns) if (ins.resultId != null) byId.set(ins.resultId, ins);

  const combined = [];
  for (const ins of mod.insns) {
    if (ins.op !== Op.Variable || ins.words[2] !== SC.UniformConstant) continue;
    const ptr = byId.get(ins.words[0]);
    if (!ptr || ptr.op !== Op.TypePointer) continue;
    const sampled = byId.get(ptr.words[2]);
    if (sampled && sampled.op === Op.TypeSampledImage)
      combined.push({ varIns: ins, sampledTy: sampled.resultId, imageTy: sampled.words[1] });
  }
  if (!combined.length) return false;
  const loads = mod.insns.filter(ins => {
    if (ins.op !== Op.Load || !inFunction(mod, ins)) return false;
    const t = byId.get(ins.resultType);
    return t && t.op === Op.TypeSampledImage;
  });
  if (!loads.length) return false;

  const decos = mod.insns.filter(i => i.op === Op.Decorate);
  const setOf = id => decos.find(d => d.words[0] === id && d.words[1] === Dec.DescriptorSet)?.words[2] ?? 0;
  const bindOf = id => decos.find(d => d.words[0] === id && d.words[1] === Dec.Binding)?.words[2] ?? 0;
  const maxBind = new Map();
  for (const d of decos) {
    if (d.words[1] !== Dec.Binding) continue;
    const s = setOf(d.words[0]);
    maxBind.set(s, Math.max(maxBind.get(s) ?? -1, d.words[2]));
  }

  const newId = makeIdSource(mod);
  const addAnnot = [], addType = [];
  const dropIdx = new Set();
  const pairs = new Map();

  const findType = (op, eq) => mod.insns.find(i => i.op === op && eq(i))?.resultId ?? null;
  let samplerTy = findType(Op.TypeSampler, () => true);
  if (samplerTy == null) {
    samplerTy = newId();
    addType.push({ op: Op.TypeSampler, words: [samplerTy], resultType: null, resultId: samplerTy });
  }
  const ptrFor = elem => {
    const hit = findType(Op.TypePointer, i => i.words[1] === SC.UniformConstant && i.words[2] === elem);
    if (hit != null) return hit;
    const id = newId();
    addType.push({ op: Op.TypePointer, words: [id, SC.UniformConstant, elem], resultType: null, resultId: id });
    return id;
  };

  for (const c of combined) {
    const varId = c.varIns.resultId;
    const set = setOf(varId), imgBind = bindOf(varId);
    const sampBind = (maxBind.get(set) ?? imgBind) + 1;
    maxBind.set(set, sampBind);
    const imgVar = newId(), sampVar = newId();
    addType.push({ op: Op.Variable, words: [ptrFor(c.imageTy), imgVar, SC.UniformConstant], resultType: ptrFor(c.imageTy), resultId: imgVar });
    addType.push({ op: Op.Variable, words: [ptrFor(samplerTy), sampVar, SC.UniformConstant], resultType: ptrFor(samplerTy), resultId: sampVar });
    addAnnot.push({ op: Op.Decorate, words: [imgVar, Dec.DescriptorSet, set], resultType: null, resultId: null });
    addAnnot.push({ op: Op.Decorate, words: [imgVar, Dec.Binding, imgBind], resultType: null, resultId: null });
    addAnnot.push({ op: Op.Decorate, words: [sampVar, Dec.DescriptorSet, set], resultType: null, resultId: null });
    addAnnot.push({ op: Op.Decorate, words: [sampVar, Dec.Binding, sampBind], resultType: null, resultId: null });
    pairs.set(varId, { imageVar: imgVar, samplerVar: sampVar, sampledTy: c.sampledTy, imageTy: c.imageTy });
    mod.insns.forEach((ins, i) => {
      if (ins.op === Op.Variable && ins.resultId === varId) dropIdx.add(i);
      if ((ins.op === Op.Decorate || ins.op === Op.Name) && ins.words[0] === varId) dropIdx.add(i);
    });
    const nm = decodeStr(mod.insns.find(i => i.op === Op.Name && i.words[0] === varId) ?? { words: [] });
    if (nm) {
      addType.push({ op: Op.Name, words: [imgVar, ...strWords(nm)], resultType: null, resultId: null });
      addType.push({ op: Op.Name, words: [sampVar, ...strWords(nm + '$spl')], resultType: null, resultId: null });
    }
    log.push(`spirvfix R1: split combined uniform %${varId} -> image %${imgVar} (set ${set}, binding ${imgBind}) + sampler %${sampVar} (binding ${sampBind})`);
  }

  // SPIR-V 1.4+ lists descriptor globals in OpEntryPoint interfaces.
  // Preserve that interface when the original combined variable is deleted.
  // https://registry.khronos.org/SPIR-V/specs/unified1/SPIRV.html#OpEntryPoint
  for (const ins of mod.insns) {
    if (ins.op !== Op.EntryPoint) continue;
    let start = 2; // execution model, function ID, then NUL-terminated name
    while (start < ins.words.length) {
      const word = ins.words[start++];
      if ([0, 8, 16, 24].some(shift => ((word >>> shift) & 255) === 0)) break;
    }
    ins.words = ins.words.slice(0, start).concat(ins.words.slice(start).flatMap(id => {
      const pair = pairs.get(id);
      return pair ? [pair.imageVar, pair.samplerVar] : [id];
    }));
  }

  const kept = mod.insns.filter((_, i) => !dropIdx.has(i));
  const aPos = (() => { const s = sections({ insns: kept }); return s.lastAnnot + 1; })();
  kept.splice(Math.max(aPos, 0), 0, ...addAnnot);
  const tPos = (() => { const s = sections({ insns: kept }); return s.firstFunc < 0 ? kept.length : s.firstFunc; })();
  kept.splice(tPos, 0, ...addType.filter(i => i.op !== Op.Name));
  const dPos = (() => { const s = sections({ insns: kept }); return s.lastDebug + 1; })();
  kept.splice(Math.max(dPos, 0), 0, ...addType.filter(i => i.op === Op.Name));
  mod.insns = kept;
  byId.clear();
  for (const ins of mod.insns) if (ins.resultId != null) byId.set(ins.resultId, ins);

  let n = 0;
  const first = pairs.values().next().value;
  for (const load of loads) {
    // Load words are [result-type, result-id, pointer, ...]: the pointer is
    // words[2]. Fall back to the first pair when the source is a temporary.
    const pair = pairs.get(load.words[2]) ?? first;
    if (!pair) continue;
    const imgLoad = newId(), sampLoad = newId();
    const idx = mod.insns.indexOf(load);
    if (idx < 0) continue;
    mod.insns.splice(idx, 1,
      { op: Op.Load, words: [pair.imageTy, imgLoad, pair.imageVar], resultType: pair.imageTy, resultId: imgLoad },
      { op: Op.Load, words: [samplerTy, sampLoad, pair.samplerVar], resultType: samplerTy, resultId: sampLoad },
      { op: Op.SampledImage, words: [load.resultType, load.resultId, imgLoad, sampLoad], resultType: load.resultType, resultId: load.resultId });
    byId.set(imgLoad, mod.insns[idx]);
    byId.set(sampLoad, mod.insns[idx + 1]);
    byId.set(load.resultId, mod.insns[idx + 2]);
    n++;
  }
  log.push(`spirvfix R1: rewrote ${n} SampledImage load(s) into OpSampledImage couples`);
  return n > 0;
}

function inFunction(mod, target) {
  let depth = 0;
  for (const ins of mod.insns) {
    if (ins === target) return depth > 0;
    if (ins.op === Op.Function) depth++;
    else if (ins.op === Op.FunctionEnd) depth--;
  }
  return false;
}
// --- R2: fold spec constants -------------------------------------------------
// OpSpecConstant* with SpecConstantOp trees become plain OpConstants holding
// default spec values (the page tier has no specialization API). Scalar and
// vector int/uint/float/bool ALU + select + composites are folded; anything
// else is left as-is and reported. Note: instruction `words` below always
// include the result type+id (see parseSpirv), so e.g. an OpConstant's value
// starts at words[2] and an OpSpecConstantOp's inner opcode is words[2].
function scalarTypeOf(byId, typeId) {
  const t = byId.get(typeId);
  if (!t) return null;
  if (t.op === Op.TypeBool) return { kind: 'bool' };
  if (t.op === Op.TypeInt) return { kind: t.words[2] ? 'sint' : 'uint', width: t.words[1] };
  if (t.op === Op.TypeFloat) return { kind: 'float', width: t.words[1] };
  return null;
}
function constValue(byId, id) {
  const ins = byId.get(id);
  if (!ins) return null;
  if (ins.op === Op.ConstantTrue || ins.op === Op.SpecConstantTrue)
    return { type: ins.words[0], elems: [{ kind: 'bool', value: true }] };
  if (ins.op === Op.ConstantFalse || ins.op === Op.SpecConstantFalse)
    return { type: ins.words[0], elems: [{ kind: 'bool', value: false }] };
  if (ins.op !== Op.Constant && ins.op !== Op.SpecConstant &&
      ins.op !== Op.ConstantComposite && ins.op !== Op.SpecConstantComposite) return null;
  const t = byId.get(ins.words[0]);
  if (!t) return null;
  if (t.op === Op.TypeVector) {
    const n = t.words[2];
    if (ins.words.length - 2 !== n) return null;
    const elems = [];
    for (const c of ins.words.slice(2)) {
      const v = constValue(byId, c);
      if (!v || v.elems.length !== 1) return null;
      elems.push(v.elems[0]);
    }
    return { type: ins.words[0], elems };
  }
  const s = scalarTypeOf(byId, ins.words[0]);
  if (!s || ins.words.length - 2 < 1) return null;
  return { type: ins.words[0], elems: [{ ...s, value: decodeScalar(s, ins.words.slice(2)) }] };
}
function decodeScalar(s, words) {
  if (s.kind === 'bool') return words[0] !== 0;
  if (s.kind === 'float') {
    if (s.width === 64) {
      const b = new Uint8Array(8); new Uint32Array(b.buffer).set(words.slice(0, 2));
      return new Float64Array(b.buffer)[0];
    }
    const b = new Uint8Array(4); new Uint32Array(b.buffer)[0] = words[0];
    return new Float32Array(b.buffer)[0];
  }
  let v = 0n;
  for (let i = words.length - 1; i >= 0; i--) v = (v << 32n) | BigInt(words[i]);
  if (s.kind === 'sint') {
    const bits = BigInt(s.width);
    if (v >> (bits - 1n)) v -= 1n << bits;
  }
  return v;
}
function encodeScalar(s, value) {
  if (s.kind === 'bool') return [value ? 1 : 0];
  if (s.kind === 'float') {
    if (s.width === 64) {
      const b = new Uint8Array(8); new Float64Array(b.buffer)[0] = value;
      return Array.from(new Uint32Array(b.buffer));
    }
    const b = new Uint8Array(4); new Float32Array(b.buffer)[0] = value;
    return [new Uint32Array(b.buffer)[0]];
  }
  let v = BigInt(value);
  v &= (1n << BigInt(s.width)) - 1n;
  const out = [];
  for (let w = 0; w < s.width / 32; w++) { out.push(Number(v & 0xffffffffn)); v >>= 32n; }
  return out;
}
// Inner-opcode numbers (SPIR-V unified1).
const SOP = {
  SNegate: 126, FNegate: 127, IAdd: 128, FAdd: 129, ISub: 130, FSub: 131,
  IMul: 132, FMul: 133, UDiv: 134, SDiv: 135, FDiv: 136, UMod: 137,
  SRem: 138, SMod: 139, FRem: 140, FMod: 141, IEqual: 170, INotEqual: 171,
  UGreaterThan: 172, SGreaterThan: 173, UGreaterThanEqual: 174,
  SGreaterThanEqual: 175, ULessThan: 176, SLessThan: 177,
  ULessThanEqual: 178, SLessThanEqual: 179, FOrdEqual: 180,
  FUnordEqual: 181, FOrdNotEqual: 182, FOrdLessThan: 184,
  FUnordLessThan: 185, FOrdGreaterThan: 186, FUnordGreaterThan: 187,
  FOrdLessThanEqual: 188, FUnordLessThanEqual: 189,
  FOrdGreaterThanEqual: 190, FUnordGreaterThanEqual: 191,
  ShiftRightLogical: 194, ShiftRightArithmetic: 195, ShiftLeftLogical: 196,
  BitwiseOr: 197, BitwiseXor: 198, BitwiseAnd: 199, Not: 200,
  LogicalEqual: 164, LogicalNotEqual: 165, LogicalOr: 166,
  LogicalAnd: 167, LogicalNot: 168, Select: 169,
};

function evalLane(inner, xs) {
  // One component lane. xs: [{kind, width, value}] (bool: boolean; float:
  // Number; int/uint: BigInt). Returns {kind, width, value} or null.
  const k = xs[0].kind, w = xs[0].width ?? 32;
  const num = x => (x.kind === 'float' ? x.value : Number(x.value));
  const big = x => BigInt(x.kind === 'bool' ? (x.value ? 1 : 0) : x.value);
  const M = (1n << BigInt(w)) - 1n;
  const wrapU = v => ((v % (M + 1n)) + (M + 1n)) % (M + 1n);
  try {
    switch (inner) {
      case SOP.Select: {
        if (xs.length !== 3) return null;
        const c = xs[0].kind === 'bool' ? xs[0].value : big(xs[0]) !== 0n;
        const p = c ? xs[1] : xs[2];
        return { kind: p.kind, width: p.width ?? 1, value: p.value };
      }
      case SOP.IAdd: case SOP.FAdd:
        return k === 'float'
          ? { kind: k, width: w, value: num(xs[0]) + num(xs[1]) }
          : { kind: k, width: w, value: wrapU(big(xs[0]) + big(xs[1])) };
      case SOP.ISub: case SOP.FSub:
        return k === 'float'
          ? { kind: k, width: w, value: num(xs[0]) - num(xs[1]) }
          : { kind: k, width: w, value: wrapU(big(xs[0]) - big(xs[1])) };
      case SOP.IMul: case SOP.FMul:
        return k === 'float'
          ? { kind: k, width: w, value: num(xs[0]) * num(xs[1]) }
          : { kind: k, width: w, value: wrapU(big(xs[0]) * big(xs[1])) };
      case SOP.UDiv: {
        if (k !== 'uint' || big(xs[1]) === 0n) return null;
        return { kind: k, width: w, value: wrapU(big(xs[0]) / big(xs[1])) };
      }
      case SOP.SDiv: {
        if (k !== 'sint' || big(xs[1]) === 0n) return null;
        /** @param {bigint} v @returns {bigint} */
        const si = v => { v = wrapU(v); const h = (M + 1n) >> 1n; return v >= h ? v - (M + 1n) : v; };
        return { kind: k, width: w, value: wrapU(si(big(xs[0])) / si(big(xs[1]))) };
      }
      case SOP.FDiv:
        if (num(xs[1]) === 0) return null;
        return { kind: 'float', width: w, value: num(xs[0]) / num(xs[1]) };
      case SOP.UMod: {
        if (k !== 'uint' || big(xs[1]) === 0n) return null;
        return { kind: k, width: w, value: big(xs[0]) % big(xs[1]) };
      }
      case SOP.SRem: {
        if (k !== 'sint' || big(xs[1]) === 0n) return null;
        /** @param {bigint} v @returns {bigint} */
        const si = v => { v = wrapU(v); const h = (M + 1n) >> 1n; return v >= h ? v - (M + 1n) : v; };
        return { kind: k, width: w, value: wrapU(si(big(xs[0])) % si(big(xs[1]))) };
      }
      case SOP.SMod: {
        if (k !== 'sint' || big(xs[1]) === 0n) return null;
        /** @param {bigint} v @returns {bigint} */
        const si = v => { v = wrapU(v); const h = (M + 1n) >> 1n; return v >= h ? v - (M + 1n) : v; };
        const a = si(big(xs[0])), b = si(big(xs[1]));
        let r = a % b;
        if (r !== 0n && (r < 0n) !== (b < 0n)) r += b;
        return { kind: k, width: w, value: wrapU(r) };
      }
      case SOP.FRem:
        return { kind: 'float', width: w, value: num(xs[0]) % num(xs[1]) };
      case SOP.FMod: {
        const a = num(xs[0]), b = num(xs[1]);
        if (b === 0) return null;
        return { kind: 'float', width: w, value: a - b * Math.floor(a / b) };
      }
      case SOP.SNegate:
        if (k === 'float') return null;
        return { kind: k, width: w, value: wrapU(-big(xs[0])) };
      case SOP.FNegate: return { kind: 'float', width: w, value: -num(xs[0]) };
      case SOP.Not:
        if (k === 'float') return null;
        return { kind: k, width: w, value: wrapU(~big(xs[0])) };
      case SOP.ShiftLeftLogical:
        if (k === 'float') return null;
        return { kind: k, width: w, value: wrapU(big(xs[0]) << (big(xs[1]) & 63n)) };
      case SOP.ShiftRightLogical: {
        if (k === 'float') return null;
        const v = wrapU(big(xs[0])) >> (big(xs[1]) & 63n);
        return { kind: k, width: w, value: v };
      }
      case SOP.ShiftRightArithmetic: {
        if (k !== 'sint') return null;
        /** @param {bigint} v @returns {bigint} */
        const si = v => { v = wrapU(v); const h = (M + 1n) >> 1n; return v >= h ? v - (M + 1n) : v; };
        const s = big(xs[1]) & 63n;
        return { kind: k, width: w, value: wrapU(si(big(xs[0])) >> s) };
      }
      case SOP.BitwiseOr:
        if (k === 'float') return null;
        return { kind: k, width: w, value: wrapU(big(xs[0]) | big(xs[1])) };
      case SOP.BitwiseXor:
        if (k === 'float') return null;
        return { kind: k, width: w, value: wrapU(big(xs[0]) ^ big(xs[1])) };
      case SOP.BitwiseAnd:
        if (k === 'float') return null;
        return { kind: k, width: w, value: wrapU(big(xs[0]) & big(xs[1])) };
      case SOP.IEqual: case SOP.LogicalEqual:
        return { kind: 'bool', width: 1, value: big(xs[0]) === big(xs[1]) && num(xs[0]) === num(xs[1]) ? num(xs[0]) === num(xs[1]) : big(xs[0]) === big(xs[1]) };
      case SOP.INotEqual: case SOP.LogicalNotEqual:
        return { kind: 'bool', width: 1, value: !(big(xs[0]) === big(xs[1]) && String(num(xs[0])) === String(num(xs[1]))) ? big(xs[0]) !== big(xs[1]) : num(xs[0]) !== num(xs[1]) };
      case SOP.UGreaterThan: case SOP.SGreaterThan:
        return { kind: 'bool', width: 1, value: k === 'float' ? num(xs[0]) > num(xs[1]) : (k === 'uint' ? wrapU(big(xs[0])) > wrapU(big(xs[1])) : si(big(xs[0])) > si(big(xs[1]))) };
      case SOP.UGreaterThanEqual: case SOP.SGreaterThanEqual:
        return { kind: 'bool', width: 1, value: k === 'float' ? num(xs[0]) >= num(xs[1]) : (k === 'uint' ? wrapU(big(xs[0])) >= wrapU(big(xs[1])) : si(big(xs[0])) >= si(big(xs[1]))) };
      case SOP.ULessThan: case SOP.SLessThan:
        return { kind: 'bool', width: 1, value: k === 'float' ? num(xs[0]) < num(xs[1]) : (k === 'uint' ? wrapU(big(xs[0])) < wrapU(big(xs[1])) : si(big(xs[0])) < si(big(xs[1]))) };
      case SOP.ULessThanEqual: case SOP.SLessThanEqual:
        return { kind: 'bool', width: 1, value: k === 'float' ? num(xs[0]) <= num(xs[1]) : (k === 'uint' ? wrapU(big(xs[0])) <= wrapU(big(xs[1])) : si(big(xs[0])) <= si(big(xs[1]))) };
      case SOP.FOrdEqual: case SOP.FUnordEqual:
        return { kind: 'bool', width: 1, value: num(xs[0]) === num(xs[1]) };
      case SOP.FOrdNotEqual:
        return { kind: 'bool', width: 1, value: num(xs[0]) !== num(xs[1]) && num(xs[0]) === num(xs[0]) && num(xs[1]) === num(xs[1]) };
      case SOP.FOrdLessThan: case SOP.FUnordLessThan:
        return { kind: 'bool', width: 1, value: num(xs[0]) < num(xs[1]) };
      case SOP.FOrdGreaterThan: case SOP.FUnordGreaterThan:
        return { kind: 'bool', width: 1, value: num(xs[0]) > num(xs[1]) };
      case SOP.FOrdLessThanEqual: case SOP.FUnordLessThanEqual:
        return { kind: 'bool', width: 1, value: num(xs[0]) <= num(xs[1]) };
      case SOP.FOrdGreaterThanEqual: case SOP.FUnordGreaterThanEqual:
        return { kind: 'bool', width: 1, value: num(xs[0]) >= num(xs[1]) };
      case SOP.LogicalOr:
        return { kind: 'bool', width: 1, value: !!(xs[0].value || xs[1].value) };
      case SOP.LogicalAnd:
        return { kind: 'bool', width: 1, value: !!(xs[0].value && xs[1].value) };
      case SOP.LogicalNot:
        return { kind: 'bool', width: 1, value: !xs[0].value };
      default: return null;
    }
    function si(v) { v = wrapU(v); const h = (M + 1n) >> 1n; return v >= h ? v - (M + 1n) : v; }
  } catch { return null; }
}
function evalSpecOp(byId, inner, operandIds, resultType) {
  const t = byId.get(resultType);
  const count = (t && t.op === Op.TypeVector) ? t.words[2] : 1;
  const args = operandIds.map(id => constValue(byId, id));
  if (args.some(a => !a)) return null;
  const lanes = [];
  for (let lane = 0; lane < count; lane++) {
    const xs = args.map(a => (a.elems.length === 1 ? a.elems[0] : (a.elems[lane] ?? null)));
    if (xs.some(x => !x)) return null;
    const r = evalLane(inner, xs);
    if (!r) return null;
    lanes.push(r);
  }
  return { elems: lanes };
}
function rebuild(ins, op, resultType, resultId, operands) {
  // operands here are the FULL post-opcode words INCLUDING result type+id
  // (the parseSpirv convention), e.g. [type, id, value...] for OpConstant.
  // For id-only ops (ConstantTrue/False) pass resultType=null and operands=[id].
  const body = [];
  if (resultType) body.push(resultType);
  if (resultId) body.push(resultId);
  body.push(...operands);
  ins.op = op;
  ins.resultType = resultType || null;
  ins.resultId = resultId || null;
  ins.words = body;
}

function emitFoldedConstant(ins, r, cx) {
  // cx: { mod, byId, newId }. Scalar folds rewrite `ins` in place; vector
  // folds materialize one scalar OpConstant per lane just before `ins` (which
  // lives in the constants section, so logical layout stays valid) and rebuild
  // `ins` as an OpConstantComposite over them.
  const t = ins.resultType, id = ins.resultId;
  if (r.elems.length === 1 && r.elems[0].kind === 'bool') {
    // Typed form [type, id] (the SPIR-V grammar's IdResultType + IdResult;
    // naga 30.2.0's spv-in reads it; the bool type is the folded
    // SpecConstantOp's own result type).
    rebuild(ins, r.elems[0].value ? Op.ConstantTrue : Op.ConstantFalse, t, id, []);
    return;
  }
  if (r.elems.length === 1) {
    rebuild(ins, Op.Constant, t, id, encodeScalar(r.elems[0], r.elems[0].value));
    return;
  }
  const vecTy = cx.byId.get(t);
  const compTy = vecTy && vecTy.op === Op.TypeVector ? vecTy.words[1] : null;
  if (compTy == null) throw new Error('spirvfix: vector fold without vector result type');
  const lanes = r.elems.map(lane => {
    const cid = cx.newId();
    let li;
    if (lane.kind === 'bool') {
      li = { op: lane.value ? Op.ConstantTrue : Op.ConstantFalse, words: [compTy, cid], resultType: compTy, resultId: cid };
    } else {
      const w = encodeScalar({ kind: lane.kind, width: lane.width ?? 32 }, lane.value);
      li = { op: Op.Constant, words: [compTy, cid, ...w], resultType: compTy, resultId: cid };
    }
    cx.byId.set(cid, li);
    return li;
  });
  const at = cx.mod.insns.indexOf(ins);
  if (at < 0) throw new Error('spirvfix: fold target not in module');
  cx.mod.insns.splice(at, 0, ...lanes);
  rebuild(ins, Op.ConstantComposite, t, id, lanes.map(l => l.resultId));
}

// A vector-typed composite's constituents must be scalars (SPIR-V §3.28.9):
// when a folded SpecConstantComposite nests vector composites (e.g. v4 made
// of two v2s), flatten them to their scalar lane ids. Struct/array results
// keep nested composites untouched.
function flattenVecConstituents(byId, typeId, ids) {
  const t = byId.get(typeId);
  if (!t || t.op !== Op.TypeVector) return ids;
  const out = [];
  const push = id => {
    const d = byId.get(id);
    if (d && d.op === Op.ConstantComposite) {
      const dt = byId.get(d.resultType);
      if (dt && dt.op === Op.TypeVector) {
        for (const c of d.words.slice(2)) push(c);
        return;
      }
    }
    out.push(id);
  };
  for (const id of ids) push(id);
  return out;
}

export function foldSpecConstants(mod, log, specOverrides) {
  // Build specId -> override value map. Overrides come from the bridge's
  // VkSpecializationInfo capture (constantID -> raw bytes). When present,
  // the override value replaces the SPIR-V default.
  const overrideMap = new Map();
  if (specOverrides) {
    for (const o of specOverrides) {
      // o.value is a Uint8Array; convert to uint32 words (little-endian)
      const words = [];
      for (let i = 0; i < o.value.length; i += 4) {
        let w = 0;
        for (let b = 0; b < 4 && i + b < o.value.length; b++) w |= o.value[i + b] << (8 * b);
        words.push(w >>> 0);
      }
      overrideMap.set(o.constantID, words);
    }
  }
  // Map resultId -> specId from OpDecorate SpecId
  const specIdOf = new Map();
  for (const ins of mod.insns) {
    if (ins.op === 71 && ins.words[1] === 1 && ins.words.length >= 3) { // OpDecorate, SpecId
      specIdOf.set(ins.words[0], ins.words[2]);
    }
  }
  const byId = new Map();
  for (const ins of mod.insns) if (ins.resultId != null) byId.set(ins.resultId, ins);
  if (!mod.insns.some(i => i.op === Op.SpecConstantOp || i.op === Op.SpecConstantComposite)) return false;
  const newId = makeIdSource(mod);
  const cx = { mod, byId, newId };
  let folded = 0, converted = 0;
  let progress = true;
  while (progress) {
    progress = false;
    for (const ins of mod.insns) {
      if (ins.op === Op.SpecConstantComposite) {
        const ready = ins.words.slice(2).every(c => {
          const d = byId.get(c);
          return d && (d.op === Op.Constant || d.op === Op.ConstantComposite ||
            d.op === Op.ConstantTrue || d.op === Op.ConstantFalse);
        });
        if (!ready) continue;
        const flat = flattenVecConstituents(byId, ins.resultType, ins.words.slice(2));
        rebuild(ins, Op.ConstantComposite, ins.resultType, ins.resultId, flat);
        folded++; progress = true;
      } else if (ins.op === Op.SpecConstantOp) {
        const inner = ins.words[2], args = ins.words.slice(3);
        if (!args.every(c => constValue(byId, c))) continue;
        let r = null;
        try { r = evalSpecOp(byId, inner, args, ins.resultType); } catch { r = null; }
        if (!r) continue;
        try { emitFoldedConstant(ins, r, cx); } catch { continue; }
        folded++; progress = true;
      }
    }
  }
  for (const ins of mod.insns) {
    if (ins.op === Op.SpecConstant) {
      const specId = specIdOf.get(ins.resultId);
      const override = specId !== undefined ? overrideMap.get(specId) : undefined;
      const valueWords = override || ins.words.slice(2);
      rebuild(ins, Op.Constant, ins.resultType, ins.resultId, valueWords);
      if (override) log.push('spirvfix R2: applied specialization override for specId ' + specId);
      converted++;
    } else if (ins.op === Op.SpecConstantTrue) {
      const specId = specIdOf.get(ins.resultId);
      const override = specId !== undefined ? overrideMap.get(specId) : undefined;
      if (override && override[0] === 0) {
        rebuild(ins, Op.ConstantFalse, 0, ins.resultId, []);
      } else {
        rebuild(ins, Op.ConstantTrue, 0, ins.resultId, []);
      }
      converted++;
    } else if (ins.op === Op.SpecConstantFalse) {
      const specId = specIdOf.get(ins.resultId);
      const override = specId !== undefined ? overrideMap.get(specId) : undefined;
      if (override && override[0] !== 0) {
        rebuild(ins, Op.ConstantTrue, 0, ins.resultId, []);
      } else {
        rebuild(ins, Op.ConstantFalse, 0, ins.resultId, []);
      }
      converted++;
    }
  }
  const remaining = mod.insns.filter(i => i.op === Op.SpecConstantOp || i.op === Op.SpecConstantComposite);
  if (!remaining.length) {
    mod.insns = mod.insns.filter(ins => !(ins.op === Op.Decorate && ins.words[1] === Dec.SpecId));
  }
  log.push(`spirvfix R2: folded ${folded} op(s), pinned ${converted} plain spec const(s) to defaults` +
    (remaining.length ? `, ${remaining.length} UNSUPPORTED (left as-is)` : ''));
  return true;
}
// Non-point rasterization ignores PointSize and has undefined PointCoord.
// Keep their computations in Private variables only with known line/triangle
// topology. Point and unknown topology retain naga's strict unsupported error.
function privatizePointBuiltins(mod, log, topology) {
  if (![1, 2, 3, 4].includes(topology)) return false;
  const builtins = mod.insns.filter(i => i.op === Op.Decorate && i.words[1] === 11
    && [1, 16].includes(i.words[2]));
  if (!builtins.length) return false;
  const byId = new Map(mod.insns.filter(i => i.resultId != null).map(i => [i.resultId, i]));
  const ids = new Set(builtins.map(i => i.words[0]));
  // Pointer-chain result types would need independent storage-class rewriting.
  if (mod.insns.some(i => [65, 66, 67].includes(i.op) && ids.has(i.words[2]))) return false;
  if (builtins.some(deco => {
    const variable = byId.get(deco.words[0]), pointer = variable && byId.get(variable.words[0]);
    const storage = deco.words[2] === 1 ? 3 : 1;
    return !variable || !pointer || pointer.op !== Op.TypePointer
      || variable.words[2] !== storage || pointer.words[1] !== storage;
  })) return false;
  const add = [], newId = makeIdSource(mod);
  for (const deco of builtins) {
    const variable = byId.get(deco.words[0]), pointer = variable && byId.get(variable.words[0]);
    if (!variable || !pointer || pointer.op !== Op.TypePointer) return false;
    const storage = deco.words[2] === 1 ? 3 : 1;
    if (variable.words[2] !== storage || pointer.words[1] !== storage) return false;
    let privatePointer = mod.insns.concat(add).find(i => i.op === Op.TypePointer && i.words[1] === 6 && i.words[2] === pointer.words[2]);
    if (!privatePointer) {
      const id = newId();
      privatePointer = { op: Op.TypePointer, words: [id, 6, pointer.words[2]], resultId: id, resultType: null };
      add.push(privatePointer);
    }
    variable.words[0] = privatePointer.resultId; variable.resultType = privatePointer.resultId; variable.words[2] = 6;
    if (deco.words[2] === 16) {
      const zero = newId();
      add.push({ op: Op.ConstantNull, words: [pointer.words[2], zero], resultType: pointer.words[2], resultId: zero });
      variable.words[3] = zero; // zero is one permitted value of non-point PointCoord
    }
  }
  mod.insns = mod.insns.filter(i => !builtins.includes(i));
  // New types/constants must precede the globals that use them.
  const firstVariable = mod.insns.findIndex(i => i.op === Op.Variable);
  mod.insns.splice(firstVariable < 0 ? sections(mod).firstFunc : firstVariable, 0, ...add);
  if (mod.header.version < 0x00010400) for (const entry of mod.insns.filter(i => i.op === Op.EntryPoint)) {
    let start = 2;
    while (start < entry.words.length) {
      const word = entry.words[start++];
      if ([0, 8, 16, 24].some(shift => ((word >>> shift) & 255) === 0)) break;
    }
    entry.words = entry.words.slice(0, start).concat(entry.words.slice(start).filter(id => !ids.has(id)));
  }
  log.push(`spirvfix: privatized ${builtins.length} unused point builtin(s) for non-point topology ${topology}`);
  return true;
}

// Demote continues helper execution; Kill terminates it. Lower only a demote
// immediately followed by an acyclic chain of branch-only blocks ending in
// void return: no subsequent derivatives, writes or helper queries can differ.
function lowerTailDemotes(mod, log) {
  const demotes = mod.insns.filter(i => i.op === 5380);
  if (!demotes.length || mod.insns.some(i => i.op === 5381)) return false;
  const blocks = new Map(); let block = null;
  for (const i of mod.insns) {
    if (i.op === Op.Label) { block = []; blocks.set(i.words[0], block); }
    else if (i.op === Op.FunctionEnd) block = null;
    else if (block) block.push(i);
  }
  const pureReturn = (id, seen = new Set()) => {
    if (seen.has(id)) return false;
    seen.add(id);
    const tail = blocks.get(id);
    if (!tail || tail.length !== 1) return false;
    return tail[0].op === 253 || (tail[0].op === 249 && pureReturn(tail[0].words[0], seen));
  };
  for (const d of demotes) {
    const next = mod.insns[mod.insns.indexOf(d) + 1];
    if (!next || next.op !== 249 || !pureReturn(next.words[0])) return false;
  }
  for (const d of demotes) {
    const at = mod.insns.indexOf(d);
    d.op = 252; d.words = [];
    mod.insns.splice(at + 1, 1); // Kill is the block terminator, replacing branch
  }
  mod.insns = mod.insns.filter(i => !(i.op === 17 && i.words[0] === 5379)
    && !(i.op === 10 && new TextDecoder().decode(new Uint8Array(strOf(i, 0))) === 'SPV_EXT_demote_to_helper_invocation'));
  log.push(`spirvfix: lowered ${demotes.length} terminal demote(s) with no helper continuation`);
  return true;
}

// --- entry point -------------------------------------------------------------
/** @param {Uint8Array} bytes @param {{rasterTopology?: number}} [options] */
export function applySpirvFix(bytes, { rasterTopology, specOverrides } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const log = [], applied = [];
  let mod;
  try {
    mod = parseSpirv(u8);
  } catch (e) {
    return { bytes: u8, applied, log: ['parse failed: ' + (e.message || e)] };
  }
  try {
    if (splitCombinedSamplers(mod, log)) applied.push('split-combined-sampler');
  } catch (e) {
    log.push('R1 failed: ' + (e.message || e));
  }
  try {
    if (foldSpecConstants(mod, log, specOverrides)) applied.push('fold-spec-constants');
  } catch (e) {
    log.push('R2 failed: ' + (e.message || e));
  }
  try {
    if (privatizePointBuiltins(mod, log, rasterTopology)) applied.push('non-point-builtins');
  } catch (e) {
    log.push('R3 failed: ' + (e.message || e));
  }
  try {
    if (lowerTailDemotes(mod, log)) applied.push('tail-demote-to-kill');
  } catch (e) {
    log.push('R4 failed: ' + (e.message || e));
  }
  if (!applied.length) return { bytes: u8, applied, log };
  try {
    return { bytes: serializeSpirv(mod), applied, log };
  } catch (e) {
    return { bytes: u8, applied: [], log: [...log, 'serialize failed: ' + (e.message || e)] };
  }
}

export const REWRITES = ['split-combined-sampler', 'fold-spec-constants', 'non-point-builtins', 'tail-demote-to-kill'];
