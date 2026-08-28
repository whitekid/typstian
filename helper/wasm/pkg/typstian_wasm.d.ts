/** Resolves one input key, or nothing when it is absent. */
export type WasmInputReader = (path: string) => Uint8Array | undefined;

/* tslint:disable */

export class TypstianWasmSession {
    free(): void;
    [Symbol.dispose](): void;
    compile(request_json: string, read_file: WasmInputReader, read_package: WasmInputReader, read_font: WasmInputReader): unknown;
    complete(request_json: string): string;
    definition(request_json: string): string;
    environment(): string;
    forward(request_json: string): string;
    jump(request_json: string): string;
    constructor();
    register_font(path: string, bytes: Uint8Array): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_typstianwasmsession_free: (a: number, b: number) => void;
    readonly typstianwasmsession_compile: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly typstianwasmsession_complete: (a: number, b: number, c: number, d: number) => void;
    readonly typstianwasmsession_definition: (a: number, b: number, c: number, d: number) => void;
    readonly typstianwasmsession_environment: (a: number, b: number) => void;
    readonly typstianwasmsession_forward: (a: number, b: number, c: number, d: number) => void;
    readonly typstianwasmsession_jump: (a: number, b: number, c: number, d: number) => void;
    readonly typstianwasmsession_new: () => number;
    readonly typstianwasmsession_register_font: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
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
