// Die gebaute PWA in den Server legen.
//
// Der Server liefert sie aus seinem static-Ordner aus - ein Container, ein
// Prozess, eine Adresse. Ein zweiter Webserver nur fuer ein paar Dateien waere
// Aufwand ohne Gewinn.
//
// Absichtlich ein eigener Schritt und nicht Teil des Web-Baus: wer nur die
// Oberflaeche bauen will (etwa zum Ansehen), soll dabei nichts in den Server
// schreiben.
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
