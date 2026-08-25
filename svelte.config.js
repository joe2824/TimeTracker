// EINE Oberflaeche, zwei Ziele.
//
// Beide Wege benutzen adapter-static: die Anwendung ist eine reine
// Seitenanwendung ohne Server-Rendering (Tauri hat keinen Node-Server, und die
// PWA soll offline laufen). Der Unterschied liegt im Ausgabeordner - der eine
// wird von Tauri eingepackt, der andere vom Server ausgeliefert.
//
// Gebaut wird ueber BUILD_TARGET: ohne Angabe der Rechner, mit "web" die PWA.
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const web = process.env.BUILD_TARGET === "web";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      fallback: "index.html",
      pages: web ? "build-web" : "build",
      assets: web ? "build-web" : "build"
    }),
    // Der Dienstmitarbeiter wird nur fuer die PWA gebaut. In der
    // Desktop-Anwendung waere er ohne Nutzen und mit Ueberraschungen: sie laedt
    // ohnehin aus dem eigenen Paket.
    serviceWorker: { register: web }
  }
};

export default config;
