/** Ensure every generated raw declaration is callable in the built module. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { default: createOpenSwmmModule } = await import(resolve(root, "dist/openswmm_engine.js"));
const manifest = JSON.parse(readFileSync(resolve(root, "src/js/raw.manifest.json"), "utf8"));
const mod = await createOpenSwmmModule();
const names = Object.keys(manifest.functions);
const absent = names.filter((name) => typeof mod[`_${name}`] !== "function");
if (absent.length) {
  throw new Error(
    `${absent.length} generated exports are absent: ${absent.slice(0, 10).join(", ")}`,
  );
}
console.log(`exports: ${names.length} generated native functions are callable`);
