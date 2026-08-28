// Die gebaute PWA in den Server legen.
import { cp, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const QUELLE = "build-web";
const ZIEL = "server/static";

if (!existsSync(QUELLE)) {
	console.error(`${QUELLE} fehlt - erst "npm run build:web" ausfuehren.`);
	process.exit(1);
}

// Erst leeren: sonst bleiben Bau-Dateien frueherer Fassungen liegen und der
// Ordner waechst mit jedem Bau.
await rm(ZIEL, { recursive: true, force: true });
await mkdir(ZIEL, { recursive: true });
await cp(QUELLE, ZIEL, { recursive: true });

console.log(`PWA nach ${ZIEL} kopiert.`);
