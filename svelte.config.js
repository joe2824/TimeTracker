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
    alias: { $shared: "shared" }
  }
};

export default config;
