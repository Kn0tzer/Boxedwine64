import { readFileSync } from "node:fs";
import { initSync } from "./wasm/naga.js";
initSync({
    module: readFileSync(new URL("wasm/naga_bg.wasm", import.meta.url)),
});
export * from "./index.js";
//# sourceMappingURL=node.js.map