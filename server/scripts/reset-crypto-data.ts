// Einmaliges Aufräumen nach dem Umbau der Krypto-Schicht auf JWE (siehe
// src/lib/crypto/vault.ts, Commit f3d27b5): records.payload, key_wraps.payload
// und pairings.wrapped_key sind im alten Format verpackt - mit dem neuen
// Client-Code lassen sie sich nicht mehr entschlüsseln. Bereinigt nur diese
// drei Tabellen (DELETE, kein DROP - das Schema bleibt). users, credentials,
// sessions, invites, server_settings und telemetry_pings sind vom Formatwechsel
// nicht betroffen und bleiben unberührt - bestehende Konten sind danach weiter
// da, brauchen aber eine neue Wiederherstellungsphrase/Passkey-Verpackung
// (z.B. über "Konto zurückholen" fällt aus, ein neues Konto ist der Weg).
//
// Bewusst NICHT Teil der automatischen MIGRATIONS-Liste in db/index.ts - die
// läuft bei jedem Serverstart und soll keinen dauerhaften Löschschritt in der
// Migrationshistorie tragen. Von Hand anstoßen, beim eigentlichen Deployment:
//
//   npm run reset:crypto            (zeigt nur, was geloescht wuerde)
//   npm run reset:crypto -- --yes   (loescht wirklich)
import { openDb } from "../src/lib/server/db";
import { DB_FILE } from "../src/lib/server/config";

const dryRun = !process.argv.includes("--yes");

const { raw } = openDb(DB_FILE);

const TABLES = ["records", "key_wraps", "pairings"] as const;

console.log(`\nDatenbank: ${DB_FILE}`);
console.log(
  dryRun
    ? "Probelauf - es wird nichts geloescht (--yes fuer den echten Lauf)\n"
    : "\n",
);

for (const table of TABLES) {
  const { count } = raw
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get() as {
    count: number;
  };
  if (dryRun) {
    console.log(`${table}: ${count} Zeile(n) wuerden geloescht`);
    continue;
  }
  raw.prepare(`DELETE FROM ${table}`).run();
  console.log(`${table}: ${count} Zeile(n) geloescht`);
}

console.log(dryRun ? "\nNichts geaendert.\n" : "\nFertig.\n");
