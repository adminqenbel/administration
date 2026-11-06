import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listTools, toOpenApi, SAMPLE_OPENAPI_OPTIONS } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "../../../docs/generated/tools.openapi.json");

const doc = toOpenApi(listTools(), SAMPLE_OPENAPI_OPTIONS);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(doc, null, 2) + "\n", "utf8");
console.log(`Wrote ${target} (${Object.keys(doc.paths).length} tools)`);
