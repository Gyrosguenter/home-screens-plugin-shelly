# Stromverbrauch (Shelly) — Home Screens Plugin

Zeigt den aktuellen Stromverbrauch aus Shelly-Messgeräten im lokalen Netz: Gesamtleistung groß mit Verlauf (letzte ~30 Minuten), Verbrauch seit Mitternacht, darunter Einzelverbraucher mit Balken und die Differenz als „Übrige Verbraucher“.

Teil des Projekts [home-screens-magic-mirror](https://github.com/Gyrosguenter/home-screens-magic-mirror).

## Geräte

Im Editor beim Modul unter „Geräte“, eine Zeile je Messpunkt: `Name | IP-Adresse | Kanal`. Die erste Zeile ist der Gesamtverbrauch. Unterstützt Gen1 (z. B. Shelly EM, 1PM) und Gen2+ (Plus/Pro, PM Mini); die Generation wird über `/shelly` erkannt. Die Abfragen laufen über den Server-Proxy des Hubs (Berechtigung `localNetwork`), nicht direkt aus dem Browser, weil dessen CSP lokale HTTP-Adressen blockiert.

Voraussetzung: Die Shelly-Geräte sind ohne Passwort im LAN erreichbar (Authentifizierung wird nicht unterstützt).

```bash
npm install && npm run build && npm test
```

MIT
