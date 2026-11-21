// Check an installation: load the module and print what the build includes.
//
//   node check_install.mjs
import createOpenSwmmModule from "@hydrocouple/openswmm-engine-wasm/wasm";
import { VERSION, capabilities } from "@hydrocouple/openswmm-engine-wasm";

const mod = await createOpenSwmmModule();
const caps = capabilities(mod);
console.log(`openswmm-engine-wasm ${VERSION}, catalog revision ${caps.catalog_revision}`);
console.log("features:", caps.features);
