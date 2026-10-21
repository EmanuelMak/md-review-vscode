---
title: Beispieldokument für Markdown Review
tags: [test, review]
---

# Regelkreise im Alltag: ein Beispieltext

Dieser Text ist **frei erfunden** und dient nur als Testdatei. Er enthält _Hervorhebungen_, `Inline-Code`,
[Links](https://example.org "Titel") und Sonderzeichen wie „Anführungszeichen“, Umlaute (ä, ö, ü, ß) und \*Escapes\*.

Hinweis: Der Zwischenstand ist für **Donnerstag, ab 16:00 (online)** geplant &amp; wird verschoben.

---

## Teil 1: Grundlagen

### 1.1 Was ist ein Regelkreis?

Ein Kühlschrank misst die Temperatur (wahrnehmen), vergleicht sie mit dem Sollwert (einordnen),
entscheidet, ob gekühlt wird (entscheiden), und schaltet den Kompressor (handeln). Dann misst er wieder.
Das ist ein Regelkreis.

Sobald das System komplizierter wird, stellen sich Fragen: Woher weiß es, was „normal“ ist? Wo speichert
es, was es gelernt hat? Was, wenn mehrere solcher Kreise gleichzeitig laufen?

### 1.2 Bekannte Modelle

**Modell A (1970er): Beobachten, Einordnen, Entscheiden, Handeln.**
Entstanden in einem Umfeld, in dem Tempo zählt. Wer schneller einordnet, gewinnt. Kritik: keine
explizite Planung, kein explizites Lernen.

**Modell B (2000er): Überwachen, Analysieren, Planen, Ausführen über Wissen.**
Rechenzentren wurden zu groß, um sie von Hand zu verwalten. Antwort: Systeme sollen sich selbst
verwalten. Vier Selbst-Eigenschaften: self-configuring, self-healing, self-optimizing, self-protecting.

- Erster Punkt mit *Kursivem* und einem [Link](https://example.org)
- Zweiter Punkt
  - verschachtelter Punkt mit `code`
  - noch einer, der über
    zwei Zeilen geht
1. Nummeriert
2. Mit **fett** am Ende **x**

> Ein Zitat über Regelkreise, das
> über zwei Zeilen geht.

<!-- page 3 -->

## Teil 2: Vergleich

| Modell | Stufen | Lernen | Herkunft |
|---|---|---|---|
| A | 4 | implizit | Militär |
| B | **4** + Wissen | nein | Industrie |
| C | 3 | ja | Forschung |
| A | 4 | implizit | A |

Ein Absatz mit Bild ![Diagramm](bilder/diagramm.png) und einem Autolink <https://example.org/pfad>.

```python
def regelkreis():
    wert = messen()

    if wert > sollwert:
        handeln()
```

    eingerückter Codeblock
    zweite Zeile

Absatz mit bestehenden Markern: {==wichtig==}{>>EM @gelb: merken<<}, ein {++Einschub++}, ein
{--gestrichenes Wort--} und eine {~~alte~>neue~~} Formulierung.{>>EM @blau: Frage an den Agenten<<}

Absatz mit ==Obsidian-Markierung== und harter  
Zeilenumbruch.

Setext-Überschrift
------------------

Letzter Absatz.
