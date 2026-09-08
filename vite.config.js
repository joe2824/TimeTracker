import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";

import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

// process ist ein Node-Global – seit @types/node im Projekt liegt, ist es typisiert.
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async ({ command }) => ({
  plugins: [tailwindcss(), sveltekit()],

  // Der voreingestellte Server, beim Bauen eingesetzt.
  //
  // Ueber `define` und nicht ueber import.meta.env: Vite reicht nur Variablen mit
  // VITE_-Praefix an den Client durch, damit keine Server-Geheimnisse im Bundle
  // landen. Diese eine Adresse ist kein Geheimnis - sie hier ausdruecklich
  // einzusetzen ist genauer, als den Praefix-Schutz fuer alle aufzuweichen.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version ?? ""),
    // Im Entwicklungsmodus zeigt die Vorgabe auf den Server aus docker-compose:
    // dort laeuft er beim Entwickeln, und ihn jedes Mal von Hand einzutippen ist
    // ein Schritt, den niemand braucht. DEFAULT_SERVER sticht das aus, und
    // eintragen laesst sich ohnehin jederzeit etwas anderes.
    __DEFAULT_SERVER__: JSON.stringify(process.env.DEFAULT_SERVER ?? ""),
    // Der Ausweis der Tagesmeldung. Leer heisst nicht "meldet nichts": mit
    // verknuepftem Konto weist sich die Meldung ueber Geraetetoken bzw. Sitzung
    // aus. Ohne Konto ist der Schluessel der einzige Weg.
    __TELEMETRY_KEY__: JSON.stringify(process.env.TELEMETRY_KEY ?? ""),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
