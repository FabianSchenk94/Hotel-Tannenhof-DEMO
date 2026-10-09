# Hotel Tannenhof Hinterzarten – Einrichtung

## Was ist Google Apps Script?
JavaScript, das direkt in deinem Google-Konto läuft und mit Google Sheets verbunden ist. Kein Server, kein Hosting, kostenlos.
Als **Web-App** veröffentlicht, bekommt das Script eine eigene URL. Ruft jemand diese URL auf (ElevenLabs-Agent oder Website), liest bzw. schreibt das Script im Sheet und antwortet mit JSON.

```
Anrufer → Zadarma-Nummer → Telefon-Butler (ElevenLabs) ──(Webhook-Tools)──► Apps-Script-URL ──► Google Sheet
Website-Tischformular ─────────────────────────────(fetch)──────────►        "
Website-Chat (ElevenLabs) → nur Wissensbasis, keine Tools – verweist für Buchungen auf den Telefon-Butler
```

## 1. Sheet + Script anlegen (ca. 10 Min.)
1. Neues Google Sheet anlegen, Name z. B. `Tannenhof Hotelsystem`.
2. **Erweiterungen → Apps Script**. Inhalt von `Code.gs` komplett einfügen, speichern.
3. **Projekteinstellungen** (Zahnrad): Zeitzone auf `(GMT+01:00) Berlin` stellen.
4. Im Editor oben die Funktion **`setup`** auswählen → **Ausführen**. Beim ersten Mal Zugriff erlauben („Erweitert → Zu … wechseln“).
   Danach gibt es vier Blätter: `Zimmer`, `Restaurants`, `Zimmerbuchungen` (mit Demo-Buchungen), `Tischreservierungen`.
5. Optional `testLokal` ausführen → Ergebnis unter **Ausführungsprotokoll**.

## 2. Als Web-App veröffentlichen
1. **Bereitstellen → Neue Bereitstellung → Typ: Web-App**
2. Ausführen als: **Ich** · Zugriff: **Jeder**
3. URL kopieren (endet auf `/exec`).
4. Test im Browser:
   `DEINE_URL?token=tannenhof-demo&action=check_availability&check_in=2026-11-06&check_out=2026-11-08`

Wichtig: Nach jeder Code-Änderung **Bereitstellungen verwalten → Bearbeiten → Version: Neu**, sonst läuft die alte Version weiter.
Token ändern? In `Code.gs` (`TOKEN`), auf der Website (`API_TOKEN`) und in den ElevenLabs-Tools gleich setzen.

## 3. Website anbinden
In `index.html` ganz unten `const API_URL = "";` → Web-App-URL eintragen. Dann schreibt das Tischformular direkt ins Sheet. Die Verfügbarkeitsabfrage für Zimmer öffnet bewusst einen gesperrten Kalender und verweist auf Ferdinand (Telefon oder Chat).

## 4. ElevenLabs-Tools (nur Telefon-Butler; Webhook, Methode GET)
Pro Tool dieselbe URL, Query-Parameter: `token` (konstant `tannenhof-demo`), `action` (konstant) plus:

| Tool | action | Parameter, die der Agent füllt |
|---|---|---|
| `zimmer_verfuegbarkeit` | check_availability | check_in, check_out, guests, category (optional) |
| `zimmer_buchen` | book_room | category, check_in, check_out, guests, name, phone, email (optional) |
| `tisch_verfuegbarkeit` | check_table | restaurant, date, persons, time (optional) |
| `tisch_reservieren` | book_table | restaurant, date, time, persons, name, phone |

Beim Parameter-Beschreiben im Tool: Datum immer `JJJJ-MM-TT`, Uhrzeit `HH:MM`. Jede Antwort enthält `heute` und `wochentag_heute`, damit der Agent „morgen“ oder „nächsten Freitag“ korrekt umrechnet.
Für `phone` beim Telefon-Agent die Anrufernummer als dynamische Variable vorschlagen und nur bestätigen lassen.

## 5. Deutsche Telefonnummer über Zadarma
Twilio vergibt deutsche Ortsnummern nur an Firmen. Zadarma vergibt sie an Privatpersonen.
1. Konto bei zadarma.com anlegen, Guthaben aufladen.
2. Nummer bestellen, z. B. **0761 Freiburg** (passt zum Schwarzwald). Nötig: Personalausweis (beide Seiten) und Adressnachweis (Rechnung, max. 6 Monate alt) – die Adresse muss in der Stadt der Vorwahl liegen. Alternativ **07721 Villingen-Schwenningen** (näher an Hüfingen) oder **032 National** (Adresse irgendwo in Deutschland).
3. In ElevenLabs: **Telefonnummern → Nummer importieren → Aus SIP-Trunk**, Adresse `pbx.zadarma.com`, Agent zuweisen.
4. In Zadarma: **Meine PBX → Nebenstellen → Rufweiterleitung → Externer Server (SIP URI)**:
   `+49761XXXXXXX@sip.rtc.elevenlabs.io:5060;transport=tcp`
5. Nummer auf der Website im Abschnitt „Butler“ eintragen (Kommentar `BUTLER_NUMMER`).

## 6. Website veröffentlichen (GitHub Pages)
1. Neues öffentliches Repository, z. B. `hotel-tannenhof`, `index.html` und den Ordner `img/` mit den 24 Bildern hochladen (Dateinamen siehe `Tannenhof_Bild-Prompts.pdf`).
2. **Settings → Pages → Branch: main / root** → nach 1–2 Minuten erreichbar unter `https://fabianschenk94.github.io/hotel-tannenhof/`.
3. ElevenLabs-Widget: beim Chat-Agenten unter **Deploy → Channels → Widget** den Embed-Code kopieren (dort auch Avatar, Farben und Texte), unten in `index.html` an der markierten Stelle einfügen. Die Domain `fabianschenk94.github.io` in ElevenLabs als erlaubte Domain eintragen.
