import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const target of [
  resolve(rootDir, ".svelte-kit/tsconfig.json"),
  resolve(rootDir, "server/.svelte-kit/tsconfig.json"),
]) {
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "{}");
  }
}
