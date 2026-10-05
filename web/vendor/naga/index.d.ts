import type { GlslOutput, GlslParseOptions, GlslWriteOptions, HlslOutput, HlslWriteOptions, Module, ModuleInfo, MslOutput, MslWriteOptions, SpirvWriteOptions, WgslWriteOptions } from "./wasm/naga.js";
export { default as init } from "./wasm/naga.js";
export type { EntryPointReflection, GlslOutput, GlslParseOptions, GlslReflection, GlslWriteOptions, HlslOutput, HlslWriteOptions, InitInput, Module, ModuleInfo, MslOutput, MslWriteOptions, ResourceBinding, ShaderStage, SpirvWriteOptions, WgslWriteOptions, } from "./wasm/naga.js";
export { nagaVersion } from "./version.js";
export type NagaErrorKind = "parse" | "validation" | "write";
export declare class NagaError extends Error {
    readonly name = "NagaError";
    readonly kind: NagaErrorKind;
    readonly formatted: string;
    constructor(kind: NagaErrorKind, formatted: string);
}
export declare const parseWgsl: (source: string) => Module;
export declare const parseGlsl: (source: string, options: GlslParseOptions) => Module;
export declare const validate: (module: Module) => ModuleInfo;
export declare const writeWgsl: (module: Module, info: ModuleInfo, options?: WgslWriteOptions | undefined) => string;
export declare const writeSpirv: (module: Module, info: ModuleInfo, options?: SpirvWriteOptions | undefined) => Uint32Array<ArrayBufferLike>;
export declare function writeGlsl(module: Module, info: ModuleInfo, options: GlslWriteOptions & {
    reflect: true;
}): GlslOutput;
export declare function writeGlsl(module: Module, info: ModuleInfo, options: GlslWriteOptions & {
    reflect?: false;
}): string;
export declare function writeGlsl(module: Module, info: ModuleInfo, options: GlslWriteOptions): string | GlslOutput;
export declare function writeHlsl(module: Module, info: ModuleInfo, options: HlslWriteOptions & {
    reflect: true;
}): HlslOutput;
export declare function writeHlsl(module: Module, info: ModuleInfo, options?: HlslWriteOptions & {
    reflect?: false;
}): string;
export declare function writeHlsl(module: Module, info: ModuleInfo, options?: HlslWriteOptions): string | HlslOutput;
export declare function writeMsl(module: Module, info: ModuleInfo, options: MslWriteOptions & {
    reflect: true;
}): MslOutput;
export declare function writeMsl(module: Module, info: ModuleInfo, options?: MslWriteOptions & {
    reflect?: false;
}): string;
export declare function writeMsl(module: Module, info: ModuleInfo, options?: MslWriteOptions): string | MslOutput;
export declare function parseSpirv(words: Uint8Array | Uint32Array): Module;
type TranslateFrom = {
    from: "wgsl";
    source: string;
} | {
    from: "glsl";
    source: string;
    parse: GlslParseOptions;
} | {
    from: "spirv";
    source: Uint8Array | Uint32Array;
};
type TranslateTo = {
    to: "wgsl";
    options?: WgslWriteOptions;
} | {
    to: "spirv";
    options?: SpirvWriteOptions;
} | {
    to: "glsl";
    options: GlslWriteOptions;
} | {
    to: "hlsl";
    options?: HlslWriteOptions;
} | {
    to: "msl";
    options?: MslWriteOptions;
};
export type TranslateInput = TranslateFrom & TranslateTo;
export declare function translate(input: TranslateInput & {
    to: "spirv";
}): Uint32Array;
export declare function translate(input: TranslateInput & {
    to: Exclude<TranslateTo["to"], "spirv">;
}): string;
