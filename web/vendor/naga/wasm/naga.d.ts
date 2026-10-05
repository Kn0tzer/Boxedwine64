/* tslint:disable */
/* eslint-disable */

export interface ResourceBinding {
    group: number;
    binding: number;
}

export interface GlslReflection {
    textures: Record<string, { texture?: ResourceBinding; sampler?: ResourceBinding }>;
    uniforms: Record<string, ResourceBinding | undefined>;
    varyings: Record<string, { location: number; index: number }>;
    clipDistanceCount: number;
}

export interface GlslOutput {
    code: string;
    reflection: GlslReflection;
}

export interface EntryPointReflection {
    entryPoints: Record<string, { name: string } | { error: string }>;
}

export interface HlslOutput {
    code: string;
    reflection: EntryPointReflection;
}

export interface MslOutput {
    code: string;
    reflection: EntryPointReflection;
}



export type ShaderStage = "vertex" | "fragment" | "compute";

export interface GlslParseOptions {
    stage: ShaderStage;
    defines?: Record<string, string>;
}

export interface WgslWriteOptions {
    flags?: {
        explicitTypes?: boolean;
    };
}

export interface GlslWriteOptions {
    version: `${number}` | `${number} es`;
    stage: ShaderStage;
    entryPoint: string;
    bindingMap?: { group: number; binding: number; slot: number }[];
    /** @deprecated Goes away in the next major, where returning `{ code, reflection }` becomes the default. */
    reflect?: boolean;
    flags?: {
        /** @default true */
        adjustCoordinateSpace?: boolean;
        forcePointSize?: boolean;
        textureShadowLod?: boolean;
        drawParameters?: boolean;
        includeUnusedItems?: boolean;
    };
}

export interface HlslWriteOptions {
    shaderModel?: "5_0" | "5_1" | "6_0" | "6_1" | "6_2" | "6_3" | "6_4" | "6_5" | "6_6" | "6_7" | "6_8" | "6_9";
    /** @deprecated Goes away in the next major, where returning `{ code, reflection }` becomes the default. */
    reflect?: boolean;
}

export interface MslWriteOptions {
    langVersion?: [major: number, minor: number];
    /** @deprecated Goes away in the next major, where returning `{ code, reflection }` becomes the default. */
    reflect?: boolean;
}

export interface SpirvWriteOptions {
    flags?: {
        /** @default true */
        adjustCoordinateSpace?: boolean;
        /** @default true */
        labelVaryings?: boolean;
        /** @default true */
        clampFragDepth?: boolean;
        forcePointSize?: boolean;
        debug?: boolean;
    };
}



export class Module {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export class ModuleInfo {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export function parseGlsl(source: string, options: GlslParseOptions): Module;

export function parseSpirv(bytes: Uint8Array): Module;

export function parseWgsl(source: string): Module;

export function validate(module: Module): ModuleInfo;

export function writeGlsl(module: Module, info: ModuleInfo, options: GlslWriteOptions): string | GlslOutput;

export function writeHlsl(module: Module, info: ModuleInfo, options?: HlslWriteOptions): string | HlslOutput;

export function writeMsl(module: Module, info: ModuleInfo, options?: MslWriteOptions): string | MslOutput;

export function writeSpirv(module: Module, info: ModuleInfo, options?: SpirvWriteOptions): Uint32Array;

export function writeWgsl(module: Module, info: ModuleInfo, options?: WgslWriteOptions): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_module_free: (a: number, b: number) => void;
    readonly __wbg_moduleinfo_free: (a: number, b: number) => void;
    readonly parseGlsl: (a: number, b: number, c: any) => [number, number, number];
    readonly parseSpirv: (a: number, b: number) => [number, number, number];
    readonly parseWgsl: (a: number, b: number) => [number, number, number];
    readonly validate: (a: number) => [number, number, number];
    readonly writeGlsl: (a: number, b: number, c: any) => [number, number, number];
    readonly writeHlsl: (a: number, b: number, c: any) => [number, number, number];
    readonly writeMsl: (a: number, b: number, c: any) => [number, number, number];
    readonly writeSpirv: (a: number, b: number, c: any) => [number, number, number, number];
    readonly writeWgsl: (a: number, b: number, c: any) => [number, number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
