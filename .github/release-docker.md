<!-- docker-quickstart -->
---

### 🐳 Server selbst betreiben

```bash
docker pull {{IMAGE}}:{{VERSION}}
```

Für `linux/amd64` und `linux/arm64` — läuft also auch auf einem Raspberry Pi.
Eine `docker-compose.yml` daneben legen:

```yaml
services:
  timetracker:
    image: {{IMAGE}}:{{VERSION}}
    restart: unless-stopped
    environment:
      # Muss exakt stimmen — WebAuthn prüft die Adresse.
      ORIGIN: https://tracker.example.de
      # Passkeys hängen daran und überleben keinen Wechsel.
      # Von Anfang an die endgültige Domain eintragen.
      RP_ID: tracker.example.de
      # Die Türklinke für den ersten Menschen. Leeren, sobald es
      # einen Verwalter gibt — der vergibt Einladungen dann einzeln.
      INVITE_CODES: dein-erster-code
      DATA_DIR: /data
    volumes:
      # Der gesamte Zustand. Sichern heißt: diese eine Datei kopieren.
      - timetracker-data:/data
    ports:
      # Nur auf der Rückschleife — erreichbar über den Reverse-Proxy davor.
      - "127.0.0.1:3000:3000"

volumes:
  timetracker-data:
```

Starten und den ersten Verwalter ernennen:

```bash
docker compose up -d
docker compose exec timetracker node admin.mjs ernenne "<Name oder Kennung>"
```

Das Abbild ist signiert und trägt Stückliste (SBOM) und Herkunft bei sich:

```bash
cosign verify {{IMAGE}}:{{VERSION}} \
  --certificate-identity-regexp '^https://github.com/{{REPO}}/\.github/workflows/docker-build\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

gh attestation verify oci://{{IMAGE}}:{{VERSION}} --repo {{REPO}}
```
