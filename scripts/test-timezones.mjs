// Dieselbe Suite unter weit entfernten Zeitzonen laufen lassen - genau das,
// was der "timezones"-Job in .github/workflows/verify.yml in CI tut. Lokal
// gibt es dafuer keinen Gegenpart: ein Fehlschlag dort war bisher erst nach
// dem Push zu sehen. Die Zonenliste haenge, wenn sie sich in verify.yml
// aendert, hier mit an - sie ist bewusst nicht importiert, weil das YAML kein
// Modul ist.
import { spawnSync } from "node:child_process";

const ZONES = ["Pacific/Kiritimati", "Pacific/Midway", "Australia/Eucla"];

let failed = false;
for (const tz of ZONES) {
	console.log(`\n=== TZ=${tz} ===`);
	// shell: true, weil npm unter Windows ein .cmd ist - spawnSync findet es ohne
	// Shell nicht (EINVAL). Der Befehl ist fest verdrahtet, keine Nutzereingabe.
	const result = spawnSync("npm test", {
		stdio: "inherit",
		shell: true,
		env: { ...process.env, TZ: tz }
	});
	if (result.status !== 0) failed = true;
}

if (failed) {
	console.error("\nMindestens eine Zeitzone ist fehlgeschlagen.");
	process.exit(1);
}
console.log("\nAlle Zeitzonen bestanden.");
