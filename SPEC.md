# Markdown Review Mode – Entwurf für eine VS Code-Extension

Stand: 20.10.2026. Auftraggeber: Emanuel Mak. Dieses Dokument ist die vollständige Vorgabe für die Umsetzung.
Ein Agent soll damit ohne Rückfragen einen funktionierenden Prototyp (v0.1) bauen können.

## 1. Ziel in drei Sätzen

Ich will eine Markdown-Datei in VS Code in der gerenderten Ansicht öffnen und dort direkt drauflos tippen, Text
markieren und kommentieren, in verschiedenen Farben hervorheben und Markierungen wieder entfernen. Alles, was ich tue,
landet als Text in der .md-Datei, im CriticMarkup-Format, damit Claude-Agenten meine Markierungen, Kommentare und
Vorschläge lesen und auf Nachfrage gezielt darauf eingehen können. Kein zweiter Editor, keine Datenbank, keine
Sidecar-Dateien: Die .md-Datei ist die einzige Wahrheit.

## 2. Was es bewusst nicht ist (Non-Goals für v0.1)

- Kein vollwertiger WYSIWYG-Editor mit verlustfreiem Markdown-Roundtrip (kein Typora-Nachbau). Normaler Fließtext
  wird nicht frei umformatiert; der Review-Modus ergänzt und markiert nur.
- Keine Bearbeitung innerhalb von Tabellen und Codeblöcken (werden gerendert, Aktionen dort sind deaktiviert).
- Keine Synchronisation mit Git, GitHub-Reviews oder anderen Tools.
- Keine Kollaboration in Echtzeit.

## 3. Nutzergeschichten

1. Ich öffne `03-Einstieg-ins-Thema.md` per Rechtsklick mit „Open with Markdown Review“ und sehe die gerenderte Seite.
2. Ich markiere einen Satz mit der Maus und klicke in der Toolbar auf Gelb: Der Satz ist gelb hinterlegt, in der Datei
   steht jetzt `{==Satz==}{>>@gelb<<}`.
3. Ich markiere einen Satz, drücke `K` (oder Toolbar „Kommentar“): Ein kleines Eingabefeld öffnet sich, ich tippe
   „brauche ich für Folie 5“, Enter. In der Datei: `{==Satz==}{>>EM @gelb: brauche ich für Folie 5<<}`. Der Kommentar
   erscheint am rechten Rand neben dem Satz.
4. Ich setze den Cursor mitten in einen Absatz und tippe „und zwar deshalb“: Der Text erscheint grün, in der Datei
   steht `{++und zwar deshalb++}`.
5. Ich markiere ein Wort und tippe ein anderes: In der Datei steht `{~~altes Wort~>neues Wort~~}`.
6. Ich markiere ein Wort und drücke Backspace: In der Datei steht `{--Wort--}`, in der Ansicht rot durchgestrichen.
7. Ich klicke auf eine Markierung und wähle in der Toolbar „Markierung entfernen“: Die Marker verschwinden aus der
   Datei, der Text bleibt.
8. Ich fahre über einen Vorschlag und klicke „Annehmen“: `{~~alt~>neu~~}` wird zu `neu`. „Ablehnen“: wird zu `alt`.
9. Ich sage einem Claude-Agenten: „Geh auf meine Kommentare in 03 ein.“ Er findet alle `{>>EM …<<}` per grep.

## 4. Dateiformat

Basis ist CriticMarkup (http://criticmarkup.com), ergänzt um eine Farb- und Autorenangabe im Kommentar.

| Zweck | Syntax in der Datei | Darstellung |
|---|---|---|
| Einfügung | `{++text++}` | grün |
| Löschung | `{--text--}` | rot, durchgestrichen |
| Ersetzung | `{~~alt~>neu~~}` | alt rot durchgestrichen, neu grün |
| Hervorhebung ohne Kommentar | `{==text==}{>>@farbe<<}` | Hintergrund in Farbe |
| Hervorhebung mit Kommentar | `{==text==}{>>EM @farbe: Kommentar<<}` | Hintergrund in Farbe, Kommentar am Rand |
| Kommentar ohne Bezugstext | `{>>EM: Kommentar<<}` | Sprechblasen-Symbol an der Stelle, Kommentar am Rand |

Regeln:
- Der Kommentar-Kopf ist `[AUTOR] [@farbe]:`, beide Teile optional. Autor kommt aus dem Setting `mdReview.author`
  (Standard `EM`). Farbe aus dem Setting `mdReview.colors` (Standard: `gelb`, `gruen`, `blau`, `rosa`, `orange`).
  Fehlt die Farbe, gilt `gelb`.
- Ein `{==…==}` ohne folgendes `{>>…<<}` wird als gelbe Hervorhebung ohne Kommentar gerendert (Kompatibilität mit
  bestehenden Dateien).
- Marker dürfen nicht über Blockgrenzen gehen (nicht über einen Absatz, Listenpunkt oder eine Überschrift hinaus).
  Mehrzeilige Auswahl wird in einen Marker pro Block zerlegt.
- Marker werden nie verschachtelt. Markiert der Nutzer Text, der schon einen Marker enthält, wird der bestehende
  Marker zuerst aufgelöst (Hervorhebung: entfernt; Vorschlag: Nutzer wird gefragt).
- Dateien, die kein CriticMarkup enthalten, werden byte-identisch wieder gespeichert, wenn keine Aktion ausgeführt
  wurde. Die Extension formatiert nie um.

## 5. Oberfläche

### 5.1 Toolbar (oben, fest über der Vorschau)

Von links nach rechts:
1. Farbfelder für jede konfigurierte Farbe (klickbar; die aktive Farbe hat einen Rahmen). Klick bei bestehender
   Auswahl: hervorheben in dieser Farbe. Klick ohne Auswahl: setzt nur die aktive Farbe.
2. „Kommentar“ (Taste `K`): hervorheben in aktiver Farbe + Eingabefeld für den Kommentartext.
3. „Nur Kommentar“ (Taste `Shift+K`): Kommentar ohne Bezugstext an der Cursorposition.
4. „Markierung entfernen“ (Taste `Entf` bei Fokus auf einer Markierung): entfernt Hervorhebung oder Kommentar, Text
   bleibt. Bei Vorschlägen entspricht das „Ablehnen“.
5. „Alle annehmen“ / „Alle ablehnen“ (mit Bestätigung).
6. Umschalter „Vorschau: Original | Mit Markern | Nach Annahme“ (nur Ansicht, ändert die Datei nicht).
7. Rechts: Autorenkürzel (klickbar, öffnet das Setting), Zähler „3 Kommentare · 2 Vorschläge · 5 Hervorhebungen“.

### 5.2 Verhalten in der Vorschau

- Die Seite ist eine gerenderte Vorschau (markdown-it), der Text ist auswählbar, aber nicht frei editierbar.
- Tippen ohne Auswahl an einer Cursorposition erzeugt eine Einfügung `{++…++}` an der entsprechenden Stelle im
  Quelltext. Weiteres Tippen verlängert dieselbe Einfügung, solange der Cursor darin bleibt.
- Tippen mit Auswahl erzeugt eine Ersetzung `{~~Auswahl~>getippt~~}`.
- Backspace/Entf mit Auswahl erzeugt eine Löschung `{--Auswahl--}`. Backspace ohne Auswahl innerhalb einer eigenen
  Einfügung löscht aus der Einfügung. Backspace ohne Auswahl auf Originaltext löscht das Zeichen davor als `{--x--}`
  (zusammenhängende Löschungen werden zu einem Marker verschmolzen).
- Enter in einer Einfügung erzeugt einen Zeilenumbruch innerhalb des Markers (Absatzumbruch bleibt v0.2).
- Hover über einen Marker zeigt Buttons „Annehmen“, „Ablehnen“ (bei Vorschlägen) bzw. „Entfernen“, „Farbe ändern“,
  „Kommentar bearbeiten“ (bei Hervorhebungen/Kommentaren).
- Randspalte rechts: Kommentare als Karten, auf Höhe des Bezugstexts, mit Autor, Farbe und Text; Klick springt zur
  Stelle; Doppelklick bearbeitet.
- Rechtsklick-Kontextmenü mit denselben Aktionen wie die Toolbar.
- Ein Umschalter „Quelltext anzeigen“ öffnet die Datei daneben im normalen Texteditor (Split).

### 5.3 Tastenkürzel (in der Vorschau)

| Taste | Aktion |
|---|---|
| `1`…`5` (ohne Auswahl) | aktive Farbe wählen |
| `H` | Auswahl in aktiver Farbe hervorheben |
| `K` | Auswahl hervorheben + Kommentar |
| `Shift+K` | Kommentar ohne Bezugstext |
| `Entf` / `Backspace` bei fokussiertem Marker | Markierung entfernen bzw. Vorschlag ablehnen |
| `Cmd+Enter` bei fokussiertem Vorschlag | annehmen |
| `Esc` | Eingabefeld schließen, Auswahl aufheben |

Normales Tippen (Buchstaben, Ziffern, Satzzeichen, Leerzeichen) ist immer „Einfügen/Ersetzen“, deshalb sind
Buchstaben-Kürzel nur ohne Auswahl aktiv, und `H`/`K` nur mit Auswahl. Bei Konflikt gewinnt das Tippen.

## 6. Technischer Entwurf

### 6.1 Bausteine

- **Extension (Node, TypeScript):** registriert einen `CustomTextEditorProvider` (viewType `mdReview.editor`) für
  `*.md`. Nicht als Standard-Editor, sondern über „Open with…“ und einen Explorer-Kontextmenüeintrag. Command
  `mdReview.open`.
- **Webview (HTML/CSS/JS, ohne Framework):** rendert HTML aus markdown-it, hält Auswahl/Cursor, zeigt Toolbar und
  Randspalte, schickt Aktionen als Nachrichten an die Extension.
- **Parser:** markdown-it mit einem eigenen Inline-Plugin für die fünf CriticMarkup-Formen und den Kommentar-Kopf
  (`AUTOR @farbe:`). Jeder gerenderte Block bekommt `data-line-start`/`data-line-end` aus `token.map`.
- **Mapping Vorschau → Quelltext:** (1) Block über `data-line-*` finden; (2) innerhalb des Blocks den ausgewählten
  Text über den „sichtbaren Text“ des Quelltexts suchen (Markdown-Syntaxzeichen wie `**`, `_`, `` ` ``, Linkziele
  werden beim Vergleich übersprungen, aber beim Schreiben erhalten); (3) bei mehreren Treffern den n-ten Treffer
  nehmen, wobei n aus der Reihenfolge in der Vorschau kommt. Marker werden immer an Zeichen-Offsets des Quelltexts
  geschrieben, nie über DOM-Serialisierung.
- **Schreiben:** jede Aktion ist ein `WorkspaceEdit` auf das `TextDocument`; Undo/Redo kommt damit von VS Code.
  Nach jeder Änderung rendert die Webview neu (Debounce 50 ms), Scrollposition und Cursor bleiben erhalten.
- **Accept/Reject:** reine Textersetzung auf dem Marker: Annehmen von `{++a++}` → `a`, `{--a--}` → ``,
  `{~~a~>b~~}` → `b`; Ablehnen entsprechend umgekehrt. Hervorhebungen/Kommentare: „Entfernen“ lässt den Text stehen.
- **Commands (auch in der Command Palette):** `Markdown Review: Open`, `Accept at cursor`, `Reject at cursor`,
  `Accept all`, `Reject all`, `Remove all highlights`, `Next/Previous marker`.
- **Settings:** `mdReview.author` (string, `EM`), `mdReview.colors` (Liste Name→Hex),
  `mdReview.defaultColor` (`gelb`), `mdReview.showGutter` (bool).

### 6.2 Grenzen und Fehlerfälle

- Auswahl über Blockgrenzen: in Marker je Block zerlegen; bei Blöcken, die nicht unterstützt werden (Tabelle,
  Codeblock), Aktion mit Hinweis verweigern.
- Auswahl nicht eindeutig im Quelltext zu finden (z. B. gleicher Satz zweimal im Block): ersten Treffer nehmen und
  kurz einblenden „Position geschätzt, bitte prüfen“.
- Datei wird extern geändert (z. B. von einem Agenten): Vorschau aktualisiert sich über `onDidChangeTextDocument`;
  laufende Einfügung wird abgebrochen, wenn ihr Block betroffen ist.
- Sehr große Dateien (> 2 MB): Review-Aktionen deaktivieren, nur Vorschau.

### 6.3 Projektstruktur

```
md-review-vscode/
  package.json          # contributes: customEditors, commands, menus, keybindings, configuration
  src/extension.ts      # Aktivierung, Provider-Registrierung, Commands
  src/provider.ts       # CustomTextEditorProvider, Nachrichten Webview <-> Dokument
  src/criticmarkup.ts   # Parser/Serializer der Marker, Accept/Reject-Logik (reine Funktionen, testbar)
  src/mapping.ts        # Vorschau-Auswahl -> Quelltext-Offsets (reine Funktionen, testbar)
  media/main.js         # Webview-Logik (Auswahl, Tippen, Toolbar, Randspalte)
  media/style.css
  test/                 # Unit-Tests für criticmarkup.ts und mapping.ts (vitest oder mocha)
  README.md             # Bedienung, Tastenkürzel, Format
  SPEC.md               # dieses Dokument
```

Build mit esbuild, Paketierung mit `vsce package`, lokale Installation mit `code --install-extension *.vsix`.

## 7. Konvention für Agenten

Im Projektordner, in dem die Extension benutzt wird, gehört in die `CLAUDE.md`:

```
## Kommentar-Konvention (Markdown Review Mode)
Markdown-Dateien enthalten CriticMarkup: {==Text==}{>>EM @farbe: Kommentar<<} sind Emanuels Hervorhebungen und
Kommentare, {++…++}/{--…--}/{~~alt~>neu~~} seine Änderungsvorschläge. Auf Nachfrage gezielt darauf eingehen
(z. B. „geh auf meine Kommentare in 03 ein“). Marker nie stillschweigend entfernen oder umformatieren; Vorschläge
nur annehmen, wenn ausdrücklich gewünscht. Farben: gelb = wichtig für mich, gruen = verstanden/erledigt,
blau = Frage an den Agenten, rosa = für die Präsentation, orange = für die Ausarbeitung.
```

Die Farbbedeutungen sind ein Vorschlag und können angepasst werden; wichtig ist nur, dass sie dort stehen.

## 8. Meilensteine

Priorität: **v0.1 zuerst und allein.** v0.4 (PDF-Import) folgt danach. v0.5 (Handschrift) ist Vision; von ihr wird in
der Extension nur das Dateiformat (Abschnitt 12.1) und die Transkription (12.2) umgesetzt, die Stift-Ebene selbst
kommt in eine spätere iPad-App.

1. **v0.1 (Prototyp, ein Abend):** Custom Editor mit Rendering aller Marker, Toolbar mit Farben, Hervorheben,
   Kommentar, Einfügen, Ersetzen, Löschen, Entfernen, Accept/Reject pro Marker und alle. Unit-Tests für Parser und
   Mapping. Test an einer Kopie von `~/dev/Uni/SeminarWissenschaftArbHöffig/03-Einstieg-ins-Thema.md`.
2. **v0.2:** Randspalte mit Kommentarkarten, Navigation Marker vor/zurück, Absatzumbruch in Einfügungen,
   Vorschau-Umschalter Original/Marker/Nach Annahme.
3. **v0.3:** Tabellen und Codeblöcke editierbar, Marker über Blockgrenzen, Export „sauber“ (alle Marker angenommen)
   als neue Datei.

## 9. Abnahmekriterien für v0.1

- `.vsix` ist installiert; „Open with Markdown Review“ erscheint bei .md-Dateien.
- An der Testdatei funktionieren die Nutzergeschichten 2 bis 8 und die Datei enthält danach exakt die Marker aus
  Abschnitt 4 (per Diff belegt).
- Eine Datei ohne Marker bleibt nach Öffnen und Schließen ohne Aktion byte-identisch.
- Undo (Cmd+Z) im normalen Editor macht eine Review-Aktion rückgängig.
- Screenshot der Vorschau mit Toolbar, einer gelben und einer blauen Hervorhebung, einem Kommentar am Rand und
  einem Vorschlag.
- README beschreibt Bedienung, Tastenkürzel und Dateiformat.

## 10. Offene Fragen (vom Agenten selbst zu entscheiden, Entscheidung im README dokumentieren)

- Farbnamen deutsch (`gelb`) oder englisch (`yellow`) in der Datei? Vorschlag: deutsch, weil die Kommentare deutsch
  sind; Hex-Werte nur im Setting.
- Soll ein Kommentar ohne Bezugstext als eigener Absatz oder inline gespeichert werden? Vorschlag: inline an der
  Cursorposition.
- Wie mit bestehenden `==Text==` (Obsidian-Syntax) umgehen? Vorschlag: nur lesen und als gelb rendern, nie schreiben.

## 11. Erweiterung: PDF-Import (Meilenstein v0.4)

### 11.1 Entscheidung

Kein Annotieren direkt im PDF (kein eigener PDF-Viewer, keine PDF-Annotationsebene). Stattdessen: PDF einmalig nach
Markdown konvertieren, die Markdown-Kopie mit dem Review-Modus bearbeiten. Das PDF bleibt die zitierfähige Quelle;
die Markdown-Kopie ist die Arbeits- und Annotationsebene, die Agenten lesen und verändern dürfen.

Die Konvertierung wird nicht selbst gebaut, sondern an ein vorhandenes Werkzeug delegiert. Reihenfolge der Präferenz:
1. **Docling** (IBM, Python, `pip install docling`): gute Tabellen, Formeln, Abbildungen als Bilder, Seitenstruktur.
2. **marker** (`marker-pdf`): schnell, gute Qualität bei wissenschaftlichen Papern.
3. **pymupdf4llm**: leichtgewichtig, als Fallback ohne Modelle.
Das Werkzeug ist konfigurierbar (`mdReview.pdf.converter`, Standard `docling`), und die Extension prüft beim ersten
Aufruf, ob es installiert ist, und zeigt sonst den Installationsbefehl an.

### 11.2 Command „Markdown Review: Import PDF“

Eingabe: eine oder mehrere .pdf-Dateien (Explorer-Kontextmenü oder Command Palette). Ausgabe je PDF, im selben
Ordner:

```
<name>.pdf                 # unverändert
<name>.md                  # konvertierter Text
<name>.assets/             # Abbildungen, nicht konvertierbare Bereiche als PNG (Seitenausschnitt), Tabellen-Fallbacks
```

Regeln für die erzeugte Markdown-Datei:
- YAML-Frontmatter am Anfang: `source: <name>.pdf`, `converted: <Datum>`, `converter: docling <Version>`,
  `pages: <n>`, optional `doi`, `title`, `authors`, wenn der Konverter sie liefert.
- **Seitenmarker:** vor jedem Seitenbeginn eine Zeile `<!-- page 7 -->` (nicht sichtbar in der Vorschau, aber
  greppbar). Zusätzlich rendert der Review-Modus den Marker als dezente Randnotiz „S. 7“, damit beim Markieren die
  Seite sichtbar ist. Kommentare, die der Nutzer anlegt, bekommen automatisch die Seite in den Kommentarkopf:
  `{>>EM @gelb p.7: …<<}`.
- Alles, was der Konverter nicht sauber als Text liefert (komplexe Tabellen, Formelbilder, Diagramme, Scans), wird als
  Bild eingebunden: `![Fig. 3, S. 12](<name>.assets/p12-fig3.png)`. Bei Zweifel lieber Bild als kaputter Text.
- Zweispaltige Layouts werden in Lesereihenfolge zusammengeführt (Docling/marker tun das); Kopf- und Fußzeilen,
  Seitenzahlen und Zeilennummern werden entfernt.
- Der Quelltext wird nach der Konvertierung nicht weiter umformatiert; Absätze bleiben so, wie der Konverter sie
  liefert, damit spätere Diffs klein bleiben.
- Wiederholter Import überschreibt die .md nicht, wenn sie bereits Marker enthält, sondern fragt nach oder schreibt
  `<name>.v2.md`.

### 11.3 Review-Modus auf konvertierten Papern

- Die Toolbar zeigt bei Dateien mit `source:`-Frontmatter zusätzlich „PDF öffnen“ (öffnet die Seite im
  Standard-PDF-Viewer von VS Code, falls möglich an der Seite des aktuellen Markers).
- Zitate: Auswahl + Taste `Z` kopiert den Text als Zitat mit Seitenangabe in die Zwischenablage, Format
  `„…“ (<Autor Jahr>, S. 7)`, wobei Autor/Jahr aus dem Frontmatter kommen.
- Für Agenten: Die Konvention in Abschnitt 7 wird ergänzt um „Konvertierte Paper (`source:` im Frontmatter) sind
  Arbeitskopien; Änderungen am Papertext nur als Marker, nie direkt; Zitate immer mit Seite aus dem Seitenmarker“.

### 11.4 Abnahmekriterien v0.4

- Import eines IEEE-Doppelspalten-Papers (z. B. Kephart & Chess 2003) liefert lesbaren Fließtext in Lesereihenfolge,
  Abbildungen als Bilder, alle Seitenmarker an der richtigen Stelle (Stichprobe: Zitat von S. 44 ist im Block nach
  `<!-- page 44 -->`).
- Import eines Papers mit Tabellen (z. B. AWARE, Tabelle 1) liefert die Tabelle als Markdown-Tabelle oder als Bild.
- Markieren und Kommentieren funktioniert auf der konvertierten Datei wie auf jeder anderen; Kommentare tragen die
  Seite.
- Ein Batch-Import von zehn PDFs läuft ohne Eingriff durch und meldet am Ende, welche Dateien Fallbacks (Bilder statt
  Text) enthalten.

### 11.5 Was bewusst nicht gemacht wird

- Keine Rückschreibung von Markern in das PDF.
- Keine OCR-Eigenentwicklung; gescannte PDFs laufen über die OCR des gewählten Konverters.
- Keine Volltextsuche über alle Paper in der Extension; dafür reicht die VS Code-Suche über die .md-Dateien.

## 12. Erweiterung: Handschrift mit Apple Pencil am iPad (Meilenstein v0.5)

### 12.1 Entscheidung

Handschrift wird nicht in PDF gewandelt und nicht in die Markdown-Datei „hineingemalt“. Jede handschriftliche
Anmerkung ist eine eigene Bilddatei (SVG bevorzugt, sonst PNG) in einem Ordner neben der Markdown-Datei, und im
Markdown steht an der verankerten Stelle ein Marker, der auf die Datei zeigt. Agenten sehen damit (a) wo die Anmerkung
hängt, (b) das Bild selbst, das sie lesen und transkribieren können, und (c) nach der Transkription den Text.

```
03-Einstieg-ins-Thema.md
03-Einstieg-ins-Thema.ink/
  2026-10-21-01.svg        # Striche, Zeitstempel, Seite/Block-ID in den SVG-Metadaten
  2026-10-21-01.png        # optionales Rasterbild für Viewer ohne SVG
```

Marker im Markdown, direkt hinter dem Block (Absatz, Listenpunkt, Überschrift), auf den sich die Anmerkung bezieht:

```
{>>EM @gelb ink:2026-10-21-01<<}
```

Nach der Transkription (durch einen Agenten oder die Extension) wird der Marker ergänzt, die Bilddatei bleibt:

```
{>>EM @gelb ink:2026-10-21-01: Hier fehlt der Bezug zu Grant 2005, S. 165<<}
```

Hervorhebungen mit dem Stift (Textmarker über einer Zeile) werden beim Transkribieren nach Möglichkeit in normale
`{==…==}`-Marker auf dem getroffenen Text umgewandelt, damit sie wie alle anderen Hervorhebungen suchbar sind.

### 12.2 Stufe A: ohne neue Software (sofort)

- Der Projektordner liegt in iCloud Drive oder wird per Git synchronisiert (am iPad z. B. mit Working Copy).
- Am iPad schreibt der Nutzer in einer beliebigen Stift-App (Notizen, Freeform, GoodNotes) und exportiert die
  Anmerkung als Bild in den `.ink/`-Ordner; Dateiname nach Muster `JJJJ-MM-TT-nn`.
- Command „Markdown Review: Ink einfügen“ am Mac (oder ein Kurzbefehl am iPad) setzt den Marker an die gewählte
  Stelle. Ohne Command: Marker von Hand schreiben; das Format ist absichtlich kurz.
- Command „Markdown Review: Ink transkribieren“ schickt das Bild an ein Vision-Modell (konfigurierbar; Standard: der
  Claude-Agent über die normale Session, alternativ Apple-Vision-OCR über einen Kurzbefehl) und schreibt den Text in
  den Marker. Transkriptionen werden als solche gekennzeichnet (`ink:` bleibt im Kopf), damit niemand sie für
  wörtliche Eingaben hält.

### 12.3 Stufe B: Stift-Ebene in der Vorschau (v0.5, nur Vision)

Diese Stufe ist eine Zielvorstellung, kein Arbeitsauftrag für die Extension. Emanuel plant dafür später eine eigene
iPad-App, in der er direkt in der Markdown-Datei schreiben und mit dem Stift arbeiten kann. Die Extension muss nur
sicherstellen, dass das Dateiformat aus 12.1 (SVG im `.ink/`-Ordner, `ink:`-Marker im Markdown) von Anfang an
unterstützt wird (Rendern und Transkribieren), damit die spätere App dasselbe Format schreiben kann. Der folgende
Entwurf beschreibt, wie die Stift-Ebene aussehen könnte, und dient der späteren App als Ausgangspunkt.

- Die Webview der Extension wird zusätzlich als eigenständige Web-App gebaut (gleiches HTML/JS, Dateizugriff über
  die File System Access API oder einen kleinen lokalen Server am Mac; am iPad über Safari als „zum Home-Bildschirm“).
- Über dem gerenderten Text liegt eine transparente Canvas-Ebene. Pointer-Events mit `pointerType === "pen"` zeichnen
  (mit Druck), Finger scrollt, Handballen wird ignoriert. Werkzeuge: Stift, Textmarker, Radierer, Farbe aus der
  Toolbar, Rückgängig.
- Jeder Strichzug wird dem Block zugeordnet, über dem er begonnen hat (Block-ID aus `data-line-start`). Beim Speichern
  entsteht pro zusammenhängender Anmerkung eine SVG-Datei mit relativen Koordinaten zum Block, damit die Anmerkung
  bei Umbruchänderungen am Block bleibt.
- Die Vorschau zeigt vorhandene `ink:`-Marker als überlagerte SVGs an der verankerten Stelle; ausblendbar über die
  Toolbar („Handschrift anzeigen“).
- Transkription wie in Stufe A, zusätzlich als Button an jeder Ink-Anmerkung.

### 12.4 Abnahmekriterien v0.5

- Am iPad (Safari) lässt sich eine konvertierte Paper-Datei öffnen, mit dem Stift kommentieren und speichern; am Mac
  erscheint danach der Marker im Markdown und das SVG im `.ink/`-Ordner.
- Nach Änderung des Absatztextes am Mac bleibt die Anmerkung am selben Absatz hängen.
- „Ink transkribieren“ erzeugt aus einer Handschriftprobe (drei Zeilen) einen Kommentartext; Fehler sind erlaubt, aber
  der Text ist als Transkription gekennzeichnet.
- Agenten-Konvention (Abschnitt 7) ergänzt um: `ink:`-Marker sind handschriftliche Anmerkungen; Bild lesen, wenn der
  Text fehlt; Transkriptionen nie als Zitat behandeln.

### 12.5 Was bewusst nicht gemacht wird

- Keine Umwandlung von Markdown in PDF, um darin zu schreiben: Dabei gehen Textebene, Marker und Verankerung
  verloren, und Agenten könnten die Anmerkungen nicht mehr dem Text zuordnen.
- Keine eigene Handschrifterkennung; Transkription läuft über ein Vision-Modell oder System-OCR.
- Keine native iPad-App; die Web-App reicht, solange Safari Pointer-Events mit Stiftdruck liefert.
