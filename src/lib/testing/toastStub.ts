// Ein stiller Ersatz fuer svelte-sonner: in Tests gibt es keine Oberflaeche,
// die einen Toast zeigen koennte. Wer die Aufrufe PRUEFEN will, mockt weiter
// selbst mit `vi.fn()` - hier geht es nur darum, dass nichts scheitert.
export const toast = Object.assign(() => {}, {
	info() {},
	error() {},
	success() {},
	warning() {},
	loading() {},
	dismiss() {}
});
