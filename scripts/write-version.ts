import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pkgPath = join(import.meta.dir, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
const version = pkg.version ?? "0.0.0";
const outPath = join(import.meta.dir, "..", "src", "version.ts");
writeFileSync(outPath, `export const VERSION = "${version}";\n`, "utf-8");
