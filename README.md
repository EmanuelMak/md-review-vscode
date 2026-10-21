# Markdown Review Mode (v0.1, Prototyp)

Markdown-Dateien in VS Code in der **gerenderten Ansicht** markieren, kommentieren und Änderungen vorschlagen.
Alles landet als [CriticMarkup](http://criticmarkup.com) in der `.md`-Datei – keine Datenbank, keine Sidecar-Dateien.
Claude-Agenten können die Marker per `grep` finden und gezielt darauf eingehen.

## Installation (auf jedem Rechner einmal)

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/EmanuelMak/md-review-vscode/main/scripts/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/EmanuelMak/md-review-vscode/main/scripts/install.ps1 | iex
```

Das lädt die `.vsix` aus dem neuesten GitHub-Release und installiert sie mit `code --install-extension`. Beim ersten
Start fragt die Extension, ob `.md`-Dateien standardmäßig mit ihr geöffnet werden sollen (später jederzeit über
„Markdown Review: Als Standard für Markdown-Dateien setzen“).

## Updates

Die Extension prüft beim Start von VS Code und alle 6 Stunden die GitHub-Releases, installiert eine neuere Version
selbst und bietet dann „Jetzt neu starten“ (Erweiterungen neu laden) an. Manuell: „Markdown Review: Nach Updates
suchen“. Einstellung `mdReview.update.mode`: `auto` (Standard), `ask` (vorher fragen), `off`.

**Neue Version veröffentlichen** (einmal, wirkt auf allen Rechnern):

```bash
npm run release          # 0.2.0 → 0.2.1, Commit + Tag, Push
npm run release:minor    # 0.2.x → 0.3.0
```

Der Push des Tags startet die GitHub Action: Typecheck, Tests, Build, dann ein Release mit der `.vsix`. Ohne Tag
(normaler Push auf `main`) wird nur getestet und gebaut.

Lokal bauen und installieren, ohne Release: `npm run package && code --install-extension md-review-*.vsix --force`.

## Öffnen

- **Als Standard für alle `.md`** (so bei Emanuel eingerichtet), in den VS Code-User-Settings:
  `"workbench.editorAssociations": { "*.md": "mdReview.editor" }`
- In der Tab-Leiste oben rechts:
  - im normalen Texteditor einer Markdown-Datei: Sprechblasen-Knopf **Open with Markdown Review** (neben dem
    Vorschau-Knopf von VS Code)
  - im Review-Editor: **Als Text öffnen** und **Markdown-Vorschau daneben**
  Beide Knöpfe ersetzen den Tab, statt einen zweiten zu öffnen.
- Außerdem: Rechtsklick im Explorer → **Open with Markdown Review**, oder `Open With…` → *Markdown Review*.

Die eingebaute VS Code-Vorschau (`⌘⇧V`) zeigt die Marker nur als Rohtext. **Quelltext** in der Toolbar öffnet die
Datei zusätzlich daneben im Texteditor.

## Bedienung

| Was | Wie |
|---|---|
| Hervorheben | Text markieren → Farbfeld klicken, oder `H` (aktive Farbe), oder `⌥1`…`⌥5` (Farbe direkt) |
| Hervorheben + Kommentar | Text markieren → `K` oder „Kommentar“ → tippen → `Enter` (`Shift+Enter` = neue Zeile) |
| Kommentar ohne Bezugstext | Cursor setzen → `⌥K` oder „Nur Kommentar“ |
| Einfügen vorschlagen | Cursor in den Text setzen und tippen → grün `{++…++}`; weiter tippen verlängert die Einfügung |
| Ersetzen vorschlagen | Text markieren und tippen → `{~~alt~>neu~~}` |
| Löschen vorschlagen | Text markieren → `Backspace`/`Entf` → rot `{--…--}`; `Backspace` ohne Auswahl löscht das Zeichen davor, aufeinanderfolgende Löschungen werden zu einem Marker |
| Eigene Einfügung korrigieren | `Backspace` innerhalb einer grünen Einfügung löscht wirklich |
| Annehmen / Ablehnen | Maus über den Vorschlag → Hover-Leiste; oder `⌘Enter` (annehmen) am Cursor; Rechtsklick |
| Markierung entfernen | Hervorhebung anklicken → `Entf`/`Backspace`; oder Hover-Leiste „Entfernen“; oder Toolbar |
| Farbe ändern | Hervorhebung anklicken → Farbfeld; oder Hover-Leiste; oder Text darin markieren und neu hervorheben |
| Kommentar bearbeiten | Doppelklick auf die Karte am Rand; oder Hover-Leiste „Kommentar“ |
| Nächster / vorheriger Marker | `⌥↓` / `⌥↑` (fokussiert ihn; dann `Entf` = entfernen/ablehnen, `⌘Enter` = annehmen) |
| Aktive Farbe wählen | Farbfeld ohne Auswahl, `1`…`5` wenn kein Cursor im Text steht (`Esc`), `⌥1`…`⌥5` immer |
| Alle annehmen / ablehnen | Toolbar (mit Rückfrage); Command Palette auch „Remove all highlights“ |
| Toolbar ein-/ausklappen | `⌥T` oder `⌃` rechts in der Leiste; eingeklappt bleibt oben rechts nur ein kleiner `☰`-Knopf. Gilt für alle Dateien |
| Randspalte ein/aus | „Rand“ in der Toolbar (gilt für alle Dateien) |
| Toolbar auf kleinem Bildschirm | Sie bleibt einzeilig: Unter ~820 px nur Symbole (Name im Tooltip), was nicht passt, erreicht man mit `‹ ›` oder dem Mausrad |
| Ansicht | Original · Mit Markern · Nach Annahme – ändert nur die Anzeige, bearbeiten geht nur in „Mit Markern“ |
| Rückgängig | `⌘Z` – in der Review-Ansicht wie im Texteditor (jede Aktion ist ein normales Text-Edit) |

Commands (Command Palette, Präfix „Markdown Review“): Open, Accept at cursor, Reject at cursor, Accept all,
Reject all, Remove all highlights, Next marker, Previous marker, Quelltext daneben anzeigen.

Einstellungen: `mdReview.author` (Kürzel, Standard `EM`), `mdReview.colors` (Name → Hex, Reihenfolge = Tasten),
`mdReview.defaultColor` (`gelb`), `mdReview.showGutter` (Randspalte an/aus). Das Kürzel rechts in der Toolbar öffnet
die Einstellung.

## Dateiformat

| Zweck | In der Datei | Anzeige |
|---|---|---|
| Einfügung | `{++text++}` | grün |
| Löschung | `{--text--}` | rot, durchgestrichen |
| Ersetzung | `{~~alt~>neu~~}` | alt rot durchgestrichen, neu grün |
| Hervorhebung | `{==text==}{>>@farbe<<}` | Hintergrund in Farbe |
| Hervorhebung + Kommentar | `{==text==}{>>EM @farbe: Kommentar<<}` | Farbe + Karte am Rand |
| Kommentar ohne Bezugstext | `{>>EM: Kommentar<<}` (oder `{>>EM @blau: …<<}`) | Sprechblase + Karte am Rand |

Kommentar-Kopf: `[AUTOR] [@farbe] [p.N] [ink:ID]:` – alle Teile optional. Fehlt die Farbe, gilt `mdReview.defaultColor`.
`{==text==}` ohne Kommentar wird gelb angezeigt. `==text==` (Obsidian) wird gelb angezeigt, aber nie geschrieben.
`ink:`-Kommentare zeigen `<datei>.ink/<ID>.svg` (sonst `.png`) in der Karte (Format aus SPEC 12.1).
`<!-- page 7 -->` erscheint als dezente Randnotiz „S. 7“.

**Tabellen und Codeblöcke:** Hervorheben und Kommentieren geht auch dort, Tippen (Einfügen/Ersetzen/Löschen) nicht.
- In Tabellen steht der Marker in der Zelle: `| OODA | {==Boyd==}{>>EM @gelb: Quelle?<<} |`. Eine Auswahl über mehrere
  Zellen ergibt einen Marker pro Zelle. Ein `|` im Kommentar würde die Tabelle zerbrechen und wird als `¦` gespeichert.
- In Codeblöcken steht der Marker direkt im Code: `    {==sense()==}{>>EM @blau: warum hier?<<}`. Dort zählen nur
  Hervorhebungen und Kommentare **mit einer konfigurierten Farbe** (deshalb tragen Kommentare im Code immer `@farbe`).
  So bleiben CriticMarkup-*Beispiele* in Code – etwa `{>>EM @farbe: …<<}` in einer Doku – normaler Code und werden
  von „Alle annehmen/ablehnen/entfernen“ nie angefasst. Eine Auswahl über eine Leerzeile wird an der Leerzeile geteilt.
  Achtung: Solange Marker im Code stehen, ist der Code so nicht lauffähig – „Markierung entfernen“ stellt ihn exakt
  wieder her.

## Entscheidungen (offene Fragen aus SPEC Abschnitt 10 und was beim Bauen dazukam)

- **Farbnamen deutsch** (`gelb`, `gruen`, `blau`, `rosa`, `orange`); Hex-Werte nur im Setting.
- **Kommentar ohne Bezugstext inline** an der Cursorposition. Farbe wird nur geschrieben, wenn sie nicht die
  Standardfarbe ist (`{>>EM: …<<}` wie in der Spec, sonst `{>>EM @blau: …<<}`).
- **`==Obsidian==`** nur lesen und gelb rendern. Erst wenn man die Farbe ändert oder einen Kommentar ergänzt, wird
  daraus `{==…==}{>>…<<}`.
- **Tastenkürzel vs. Tippen:** Mit Auswahl sind `H` und `K` Kürzel (Nutzergeschichte 3), alle anderen Zeichen ersetzen
  die Auswahl. Wer eine Auswahl durch ein Wort mit h/k am Anfang ersetzen will: erst `Backspace` (Löschung), dann tippen
  – oder ein anderes Zeichen zuerst. `Shift+K` aus der Spec kollidiert mit dem Tippen eines großen „K“ am Cursor,
  deshalb ist „Nur Kommentar“ auf `⌥K`. Ziffern wählen die Farbe nur, wenn kein Cursor im Text steht.
- **Keine Verschachtelung:** Hervorheben über eine bestehende Hervorhebung vereinigt beide (Kommentare werden mit
  „ / “ zusammengeführt); liegt die Auswahl ganz in einer Hervorhebung, ändert sich nur deren Farbe. Überschneidet eine
  Aktion einen Vorschlag oder eine kommentierte Hervorhebung, fragt ein Dialog (annehmen / ablehnen / abbrechen).
  Schlichte Hervorhebungen ohne Kommentar werden beim Tippen/Löschen darin stillschweigend aufgelöst.
- **Formatierung wird nie zerschnitten:** Trifft eine Auswahl `**fett**`, einen Link o. Ä. nur teilweise, wird der
  Marker um die ganze Formatierung gelegt. Code, Bilder, Escapes und Entities sind unteilbar.
- **Zuordnung Vorschau → Quelltext ist exakt**, nicht geschätzt: Jedes gerenderte Textstück trägt seinen Zeichen-Offset
  in der Datei. Der Hinweis „Position geschätzt“ aus der Spec kommt deshalb nicht vor.
- **Enter** erzeugt nur innerhalb einer eigenen Einfügung einen Zeilenumbruch; Absätze anlegen kommt in v0.2.
- Randspalte, Marker-Navigation und Ansichtsumschalter (eigentlich v0.2) sind schon drin, weil sie billig waren und
  die Abnahme („Kommentar am Rand“) sie braucht.

## Grenzen von v0.1

- In Tabellen und Codeblöcken nur Hervorheben/Kommentieren, kein Tippen. HTML-Blöcke und Frontmatter sind gar
  nicht bearbeitbar. Zellen mit `\|` (escaptem Pipe) lassen sich nicht markieren.
- Keine Marker über Blockgrenzen (eine Auswahl über mehrere Absätze ergibt einen Marker pro Absatz).
- Dateien > 2 MB: nur Vorschau.
- Bilder werden nur aus dem Ordner der Datei bzw. dem Workspace geladen.

## Für Claude-Agenten

In die `CLAUDE.md` des Projekts, in dem die Extension benutzt wird:

```markdown
## Kommentar-Konvention (Markdown Review Mode)
Markdown-Dateien enthalten CriticMarkup: {==Text==}{>>EM @farbe: Kommentar<<} sind Emanuels Hervorhebungen und
Kommentare, {++…++}/{--…--}/{~~alt~>neu~~} seine Änderungsvorschläge. Auf Nachfrage gezielt darauf eingehen
(z. B. „geh auf meine Kommentare in 03 ein“). Marker nie stillschweigend entfernen oder umformatieren; Vorschläge
nur annehmen, wenn ausdrücklich gewünscht. Farben: gelb = wichtig für mich, gruen = verstanden/erledigt,
blau = Frage an den Agenten, rosa = für die Präsentation, orange = für die Ausarbeitung.
```

Alle Kommentare finden: `grep -n '{>>EM' datei.md`

## Entwicklung

```bash
npm test             # Unit-Tests (Parser, Mapping, Aktionen) inkl. Offset-Prüfung an einer echten Datei
npm run typecheck
npm run watch        # esbuild im Watch-Modus; F5 in VS Code startet einen Extension Host
```

`dev/index.html` ist ein Browser-Harness, der den Provider nachbildet: `npm run harness` (optional mit eigener Datei:
`node dev/build-harness.mjs pfad/zur/datei.md`), dann `python3 -m http.server` im Projektordner und `/dev/index.html`
öffnen.

Aufbau: `src/criticmarkup.ts` (Marker erkennen, annehmen/ablehnen), `src/mapping.ts` (markdown-it + Offsets),
`src/render.ts` (HTML mit `data-s`/`data-a`/`data-m`), `src/actions.ts` (alle Aktionen als reine Textfunktionen),
`src/provider.ts` (Webview ↔ TextDocument), `src/update.ts` (Selbst-Update aus GitHub-Releases), `media/main.js`
(Webview).
