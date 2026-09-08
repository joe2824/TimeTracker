// EINE Oberflaeche, zwei Ziele.
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
    serviceWorker: { register: web },
    alias: { $shared: "shared" },
    // Nur script-src: der Server (hooks.server.ts) setzt die restliche CSP
    // schon per Header. Das eine Inline-Skript, das SvelteKit selbst in
    // index.html einbaut (startet die App, meldet den Dienstmitarbeiter an),
    // bekommt so seinen eigenen Hash statt eines pauschalen 'unsafe-inline' -
    // ein eingeschleustes <script> passt nicht auf den Hash und bleibt tot.
    // "hash" statt "auto": bei adapter-static gibt es keinen Server, der einen
    // Nonce je Anfrage einsetzen koennte - "auto" liefe bei prerenderten
    // Seiten ohnehin auf "hash" hinaus.
    csp: {
      mode: "hash",
      directives: {
        "script-src": ["self"]
      }
    }
  }
};

export default config;
