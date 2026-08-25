// Der Server laeuft als Node-Prozess: er beantwortet die API und liefert die
// PWA-Dateien aus. Ein Prozess, ein Container, ein Volume.
import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
export default {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter(),
		// Schreibende Anfragen nur von bekannten Herkuenften. Die API wird aus der
		// PWA und aus der Desktop-Anwendung heraus gerufen - letztere meldet sich
		// mit einem Geraete-Token statt mit einem Cookie und ist davon nicht
		// betroffen.
		csrf: { trustedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean) }
	}
};
