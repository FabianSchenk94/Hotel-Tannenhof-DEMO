# Hotel Tannenhof Hinterzarten – KI-Agenten-Demo

**Live:** https://fabianschenk94.github.io/Hotel-Tannenhof-DEMO/

> Fiktives Demo-Hotel. Kein reales Haus, keine echten Buchungen.

Ein vollständig erfundenes 4-Sterne-Superior-Hotel im Hochschwarzwald als Spielwiese für zwei KI-Agenten:

| Agent | Kanal | Aufgabe |
|---|---|---|
| **Website-Chat** | Chat-Widget auf der Seite | Beantwortet Fragen zu Zimmern, Restaurants, Spa, Anreise und FAQ |
| **Telefon-Butler** | Echte Telefonnummer | Beantwortet Fragen, prüft freie Zimmer und Tische, bucht und reserviert |

Beide Agenten antworten standardmäßig auf Deutsch und wechseln bei Bedarf auf Englisch, Französisch, Italienisch oder Niederländisch.

## Architektur

```
Anrufer ──► Telefonnummer (SIP) ──► ElevenLabs Voice Agent ──┐
                                                             ├──► Webhook-Tools ──► Google Apps Script ──► Google Sheet
Website ──► ElevenLabs Chat-Widget ──────────────────────────┘                     (Verfügbarkeit, Buchung)
Website-Formulare ───────────────────────────────────────────────────────────────►
```

- **Frontend:** statischer One-Pager (HTML/CSS/JS), gehostet über GitHub Pages
- **Agenten:** ElevenLabs Agents mit Knowledge Base und Webhook-Tools
- **Backend:** Google Apps Script als Web-App, Google Sheet als „Hotelsystem“ (Zimmer, Belegung, Tischreservierungen)
- **Bilder:** KI-generiert (OpenAI Images)

## Inhalt

| Datei | Zweck |
|---|---|
| `index.html`, `img/` | Website |
| `docs/wissensbasis.md` | Wissensbasis für beide Agenten |
| `docs/agent-telefon-butler.md` | System-Prompt, Tool-Definitionen und Testfälle des Telefon-Butlers |
| `docs/agent-website-chat.md` | System-Prompt und Testfragen des Website-Chats |
| `docs/Code.gs` | Apps-Script-Backend: Verfügbarkeit, Zimmerbuchung, Tischreservierung |
| `docs/ANLEITUNG.md` | Einrichtung Schritt für Schritt |
| `docs/bilder-prompts.json` | Prompts für die Bildgenerierung |

## Konzept und Umsetzung

Fabian Schenk – [LinkedIn](https://www.linkedin.com/in/fabianschenk-ai)
