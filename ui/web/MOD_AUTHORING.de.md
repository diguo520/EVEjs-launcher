# EveJS Mod-Tutorial (aus Sicht der Autoren)

> Für alle, die **einen Mod bauen wollen**: von null bis zu einem Mod, der im Mod-Markt installiert werden kann — in **8 Schritten**.
> Es ist **keine Änderung an Serverdateien nötig** — Mods werden über den Loader eingebunden.

**Was du brauchst**: Windows 10+, einen EveJS-Server (0.12.8 oder neuer), den EvEJS Launcher 0.1.20+ und ein GitHub-Konto.

---

## 🎨 Farb- / Markierungslegende (zuerst lesen)

| Markierung | Bedeutung | Was du tun musst |
| --- | --- | --- |
| 🟥 **Gefahr** | Es schlägt fehl, gibt einen Fehler, oder die Folgen sind **unumkehrbar** | Auf keinen Fall tun |
| 🟨 **Achtung** | Leicht zu verwechseln, oder das Ergebnis weicht von der Erwartung ab | Vorher noch einmal prüfen |
| 🟦 **Tipp** | Kleiner Kniff, der Zeit spart | Kannst du nutzen |
| 🟩 **Empfohlen** | So solltest du es machen | Einfach so machen |
| ✅ **Pflicht** | Ohne das geht es nicht weiter | Muss erledigt werden |
| ⭕ **Optional** | Darf leer bleiben | Nach Bedarf |
| 🧩 **Beispiel** | Code / Konfiguration zum Abschreiben | Kopieren und anpassen |

> GitHub-Markdown, die VS-Code-Vorschau, Typora und Co. zeigen diese farbigen Markierungen korrekt an (es sind Emoji, **kein Plugin nötig**).

---

## 📋 Übersicht der Schritte

| # | Schritt | Wo | Ungefähre Dauer | Pflicht? |
| --- | --- | --- | --- | --- |
| 1 | Umgebung prüfen (Version / mods-Verzeichnis) | Launcher | 2 Minuten | ✅ |
| 2 | **Autoren-Identität** anlegen und `.eve-key` exportieren | Launcher | 2 Minuten | ✅ |
| 3 | **GitHub-Token** anlegen (classic, public_repo ankreuzen) | GitHub-Webseite | 5 Minuten | ✅ (nötig zum Veröffentlichen und Einreichen) |
| 4 | **Mod erstellen** (Grundgerüst erzeugen) | Launcher | 3 Minuten | ✅ |
| 5 | Deine Logik schreiben (`loader.js`) | Editor | Je nach Bedarf | ✅ |
| 6 | Lokal testen (aktivieren / Logs ansehen) | Launcher | 5 Minuten | 🟩 Empfohlen |
| 7 | **Veröffentlichen** (packen → in dein Repo pushen → Prüf-PR öffnen, mit einem Klick) | Launcher | 1 Minute | ✅ |
| 8 | Neue Version veröffentlichen (Versionsnummer ändern → erneut „Veröffentlichen“) | Launcher | 1 Minute | 🟩 Empfohlen |

> 🟦 **Einmalig vs. jedes Mal**: Die Schritte 1–4 machst du nur einmal; danach läuft jede Version nur noch über **Schritt 7** (Packen, Repo-Push und Prüf-PR in einem Rutsch, siehe Teil 3).

---

# Teil 1: Vorbereitung (einmalig)

## Schritt 1 ✅ Umgebung prüfen

1. Launcher öffnen → **Umgebungs-Selbsttest**: 9 Punkte (Node.js / Abhängigkeiten / Client-Pfad …); rote zuerst beheben.
2. EveJS-Serverwurzel prüfen (enthält `server/`, `config/`). Im Launcher → **Konfigurationszentrum** siehst du den aktuell genutzten Pfad.
3. Prüfen, dass das **`mods/`-Verzeichnis** existiert. Falls nicht: Mods / Plugins → **mods/ automatisch anlegen**.

🟨 **Achtung**: Das Mod-Verzeichnis ist fest `<EveJS-Wurzel>/mods/<Mod-Kennung>/`. Lege es **nicht** woanders ab und benenne es nicht in Nicht-ASCII-Zeichen um.

---

## Schritt 2 ✅ Autoren-Identität anlegen (der Beleg dafür, „wer du bist“)

Mods / Plugins → oben **Token-Konfiguration** (Autoren-Identität und GitHub-Token im selben Dialog):

1. **Beim ersten Öffnen wird dein Ed25519-Schlüsselpaar automatisch erzeugt** (kein Knopf nötig)
2. **Anzeigename** ändern (der sichtbare Name, z. B. „Kommandant“) → **Anzeigename speichern**
3. **Schlüssel exportieren** → als `.eve-key`-**Datei an einem sicheren Ort** ablegen (USB-Stick / Passwortmanager)
4. Rechnerwechsel: auf dem neuen Rechner **Schlüssel importieren** und diese `.eve-key` wählen — die Identität ist wieder da
5. Der Knopf **Schlüsselverzeichnis** öffnet direkt den Ordner mit dem privaten Schlüssel (`_launcher/data/mod-keys/`)

Du bekommst drei Dinge:

| Ding | Erklärung | Aufbewahren? |
| --- | --- | --- |
| **Autoren-Kennung** (`au-...`) | Steht im Mod-Manifest und bedeutet „dieser Mod ist von dir“ | Wird automatisch ins Manifest geschrieben |
| **Schlüssel-Fingerabdruck** (`keyId`, 12 Zeichen) | Dient der Signaturprüfung | Wird automatisch ins Manifest geschrieben |
| **`.eve-key`-Datei** | Enthält den **privaten Schlüssel** | 🟥 **Unbedingt sicher aufbewahren** |

🟥 **Gefahr**:
- **Die `.eve-key` ist deine Identität.** Geht sie verloren → du kannst **nie wieder ein Update signieren** (alte Nutzer sehen „Signatur fehlgeschlagen“); gelangt sie in falsche Hände → jemand kann als du veröffentlichen.
- **Niemals** `.eve-key` oder `_launcher/data/mod-keys/*.key` auf GitHub committen, an andere weitergeben oder in ein ZIP packen.

🟩 **Empfohlen**: Beim Rechnerwechsel die `.eve-key` über „Schlüssel importieren“ zurückholen — die Identität ist wieder da.

---

## Schritt 3 ✅ GitHub-Token anlegen (nötig zum Veröffentlichen und Einreichen)

Der Launcher handelt für dich auf GitHub: beim **Veröffentlichen** schreibt er Dateien in dein eigenes Repo, legt ein Release an und lädt das ZIP hoch; beim **Aufnahmeantrag** legt er einen Fork des Index-Repos `diguo520/EVEjs-mods` (gehört dem Maintainer) an und öffnet eine PR. Ein **classic-Token** deckt beides ab.

### 3.1 Die richtige Seite öffnen 🟨

```
GitHub, oben rechts Avatar → Settings → in der linken Spalte ganz unten Developer settings
  → Personal access tokens → Tokens (classic) → Generate new token (classic)
```

Folge dem Bild unten (die Nummern entsprechen den roten Kreisen auf der Seite):

![GitHub classic-Token-Seite: ① Tokens (classic) ② Generate new token (classic) ③ Note ④ Expiration ⑤ repo ankreuzen](./github-token-classic.png)

| Nr. | Wo klicken / was eintragen |
| --- | --- |
| ① | Linke Spalte **Tokens (classic)** — nicht „Fine-grained tokens“ darüber |
| ② | **Generate new token** → **Generate new token (classic)** |
| ③ | **Note**: beliebig, z. B. `evejs-launcher` |
| ④ | **Expiration**: 90 Tage empfohlen (nach Ablauf neu erzeugen) |
| ⑤ | Unter **Select scopes** **repo** ankreuzen (`public_repo` ist eine Unteroption; mit repo ist sie abgedeckt) |

🟥 **Kein Fine-grained-Token verwenden**: Dessen „Repository access“ lässt nur Repos zu, auf die du schon Rechte hast — nicht das Index-Repo `EVEjs-mods` des Maintainers. Fork anlegen und PR öffnen brauchen aber Schreibrechte auf genau diesem Repo. Mit einem Fine-grained-Token scheitert das Einreichen zwangsläufig mit `403 Resource not accessible by personal access token`.

### 3.2 Basisdaten eintragen

| Feld | Was eintragen |
| --- | --- |
| Note | Beliebig, z. B. `evejs-launcher` |
| Expiration | 90 Tage empfohlen oder individuell (nach Ablauf neu erzeugen) |

### 3.3 Scopes ankreuzen (der wichtige Teil) 🟨

| scope | Ankreuzen? | Wirkung |
| --- | --- | --- |
| **public_repo** | 🟩 Pflicht | Lesen/Schreiben öffentlicher Repos: Release anlegen, ZIP hochladen, Fork erstellen, PR öffnen |
| **repo** | 🟨 Empfohlen | Enthält public_repo; zusätzlich nötig, wenn der Launcher Repos automatisch anlegen oder private Repos verwalten soll |

### 3.4 Erzeugen und kopieren

**Generate token** klicken → die Zeichenkette `ghp_...` kopieren (🟨 **wird nur einmal angezeigt**; nach dem Schließen der Seite ist sie weg).

### 3.5 Im Launcher eintragen

Mods / Plugins → **Token-Konfiguration** → GitHub-Token suchen → einfügen → **Speichern** (wird lokal verschlüsselt; die Rechte werden danach automatisch geprüft) → Prüfung bestanden.

> 🟦 **Warum auf classic umstellen?** Das Index-Repo gehört dem Maintainer, ein Fine-grained-Token kommt nicht heran. Nur wer als **Mitarbeiter des Index-Repos** eingetragen ist, darf ein Fine-grained-Token nutzen: Repository access auf `EVEJS-mods` setzen, dann **Contents = Read and write** und **Pull requests = Read and write**.

🟨 **Achtung**: Nach einer Scope-Änderung oder einem neuen Token das neue Token **noch einmal einfügen und speichern**.

---

# Teil 2: Einen Mod bauen

## Schritt 4 ✅ Mod erstellen (Grundgerüst erzeugen)

Mods / Plugins → **Mod erstellen**, Formular ausfüllen:

| Feld | Pflicht | Erklärung |
| --- | --- | --- |
| Vorlage | ✅ | `Welcome Broadcast (Example)` (Beispiel mit Begrüßungsnachricht beim Login) / `Blank Skeleton` (leeres Grundgerüst). 🟩 Für den ersten Durchlauf lieber das Beispiel nehmen |
| Mod-Name | ✅ | Der Name, den Spieler sehen |
| Kennung (id / Ordnername) | 🟩 | Wird automatisch aus dem Namen erzeugt; nur `a-z 0-9 - _ .` erlaubt, nach dem Anlegen **nicht mehr ändern** |
| Version | ✅ | Standard `1.0.0`; für eine neue Version **hochzählen** (siehe Schritt 8) |
| Kategorie | ✅ | Gameplay / Wirtschaft / KI / Grafik / Werkzeuge (danach filtert der Markt) |
| Tags | ⭕ | Komma-getrennt, z. B. `Chat, Anfänger` |
| Kurzbeschreibung | 🟩 | Ein Satz, erscheint auf der Marktkarte |
| Ausführliche Beschreibung / Kernpunkte | ⭕ | Landet im README deines Mods |
| Zugehörige Mod-IDs | ⭕ | Mit welchen Mods er verknüpft ist, getrennt durch Komma oder Leerzeichen |
| Build-Optionen | — | ☑ Server neu starten (standardmäßig an), ☑ direkt nach dem Anlegen aktivieren (an), ☑ direkt nach dem Anlegen signieren (an) |

Nach dem Klick auf **Erstellen** liegt in deinem `mods/`-Verzeichnis zusätzlich:

```
mods/<deine Mod-id>/
├─ evejs-launcher.mod.json    ← Manifest (Identität, Version, Kategorie, Abhängigkeiten)
├─ loader.js                  ← die Logik, die du schreibst
├─ README.md                  ← aus „ausführliche Beschreibung“ erzeugt
└─ CHANGELOG.md               ← Versionshistorie
```

🟨 Nur wenn du „direkt nach dem Anlegen aktivieren“ **abwählst**, wird `loader.js` zu `loader.js.disabled` (standardmäßig angekreuzt, also standardmäßig ladbar). Zum Umschalten danach einfach der Schalter im Reiter **Installiert** — er benennt nur um.

🟨 **Pflichtfelder im Manifest** (der Launcher prüft sie; fehlt etwas, kommt „Manifest-Prüfung fehlgeschlagen“):

```
schemaVersion: 3                       ← muss 3 sein
id / displayName / version             ← Kennung / Name / Version
kind: "loader"                         ← nur loader lässt sich wirklich aktivieren
restart: "game_server"                 ← none | client | game_server | launcher
activation.strategy: "loader_rename"   ← genau dieser Wert
im Verzeichnis muss loader.js oder loader.js.disabled liegen
```

---

## Schritt 5 ✅ Deine Logik schreiben (`loader.js`)

Öffne `mods/<deine Mod-id>/loader.js` — ein Grundgerüst ist schon da: 🟩 **das Gerüst ist selbst ein lauffähiges Minimalbeispiel** (der Spieler bekommt 10 Sekunden nach dem Login eine Nachricht im lokalen Chat). Passe es einfach an.

🟥 **Vier harte Regeln** (stehen alle im Gerüst; jede entfernte Regel verursacht Probleme):

| Regel | Warum |
| --- | --- |
| `setImmediate` + Einstiegsprüfung (`process.env.EVEJS_GAMESTORE_OWNER_ROLE === "world"`, oder der Einstieg ist `index.js`) | `NODE_OPTIONS` wird von npm bis zum Server Schicht für Schicht vererbt; jeder Wrapper-Prozess lädt deine Datei — ohne Prüfung arbeitet dein Code im falschen Prozess |
| **Server-Großmodule nicht direkt `require`n** (`chatHub` zieht rund 456 MB / 645 Module hoch) | Warte, bis es in `require.cache` auftaucht, und nimm dann die Referenz: Cache-Treffer, kein zusätzlicher Speicher |
| `timer.unref()` | Der Timer soll das Beenden des Prozesses nicht blockieren |
| „Nur einmal installieren“ über `globalThis.__xxx` prüfen | Der Loader wird mehrfach geladen; sonst doppelte Nachrichten und immer mehr Listener |

🟨 **Pfadregel (die häufigste Falle)**: Im Loader wird `require("./src/...")` **relativ zu DEINEM Mod-Verzeichnis** aufgelöst, **nicht** relativ zur Serverwurzel — so geschrieben gibt es `MODULE_NOT_FOUND`. Richtig ist, zuerst die Serverwurzel zu berechnen:

```js
const path = require("path");
const serverRoot = path.resolve(__dirname, "..", "..", "server");
const hubPath = path.join(serverRoot, "src", "services", "chat", "chatHub.js");
// 🟨 Hier NICHT direkt require — warte, bis der Server es geladen hat; vollständiges Beispiel in Anhang B
```

🟨 **Session-Attribute**: Eigene Attribute an einer Chat-Session **werden nicht automatisch synchronisiert**; direktes Lesen/Schreiben kann „still fehlschlagen“. Nutze die Schnittstellen von `chatHub` / `sessionRegistry`.

🟩 Mods, die **Servercode ändern müssen** (nicht nur APIs aufrufen), stehen in **Anhang G** — hänge dich nicht selbst in `Module.prototype._compile` ein.

---

## Schritt 6 🟩 Lokal testen

1. Mods / Plugins → **Installiert** → deinen Mod suchen → Schalter **einschalten** (oder beim Anlegen „sofort aktivieren“ angekreuzt)
2. Launcher → Konsole → **Ein-Klick-Start** (startet Hauptserver + Markt-Dienst)
3. Ins Spiel gehen und die Wirkung prüfen
4. Bei Problemen zwei Logs ansehen:
   - Launcher → **Server-Log** (filterbar nach System / Hauptserver / Markt-Dienst / Client sowie INFO/WARN/ERROR)
   - Konsolenausgabe des Servers (im Launcher sichtbar)
5. 🟩 **Prüfen, „ob überhaupt geladen wurde und wie lange es dauerte“**: in der Serverausgabe nach `[EveJS-MOD]` suchen:
   - `loader bereit <dein Mod> 3ms` — dein Loader wurde geladen; `loader fehlgeschlagen ... :: <Grund>` heißt, er wurde nicht geladen
   - `loaders-done total=14 failed=0 ms=1086` — Gesamtdauer für alle Mods
   - `<Datei> N Schichten injiziert (A -> B Bytes)` — der Bus-Patch hat gewirkt
   - `<id> Patch fehlgeschlagen, Ergebnis der vorherigen Schicht bleibt: <Grund>` — diese Schicht wurde übersprungen (**ohne** Einfluss auf andere Mods)

   🟨 Details je Prozess und je Schicht landen zusätzlich in `_launcher/logs/mod-load-report.json` — dort siehst du bei der Frage „wer hat die Datei geändert“ direkt nach.

### 🔧 Fehlersuche auf einen Blick

| Symptom | Wahrscheinlichste Ursache |
| --- | --- |
| In der Liste steht „loader.js fehlt“ | Datei gelöscht oder umbenannt |
| Der Schalter geht von selbst wieder aus | Manifest-Prüfung fehlgeschlagen / Signatur verändert → roter Hinweis auf der Karte |
| Im Log steht kein „Modul geladen“ | Der Mod ist **deaktiviert**, oder wegen eines Konflikts übersprungen |
| Im Log steht `MODULE_NOT_FOUND` | `require("./src/...")` wurde relativ zur Serverwurzel aufgelöst — tatsächlich relativ zu deinem Mod-Verzeichnis (siehe Schritt 5) |
| Im Spiel keine Wirkung, im Log kein Fehler | Die Logik kehrt vor der „nur einmal installieren“-Prüfung zurück, oder der `require`-Pfad ist falsch |
| Node-Speicher explodiert | Ein Server-Großmodul wurde `require`t (Falle 2 in Schritt 5) |

---

# Teil 3: In den Markt veröffentlichen

> **Veröffentlichen ist ein Klick**: Der Launcher erledigt hintereinander „neu signieren → ZIP packen → in dein eigenes Repo pushen (Repo anlegen, Release erstellen, ZIP hochladen) → eine Versionsprüf-PR ans Index-Repo stellen“, du siehst nur den Fortschrittsbalken.
> Die PR ans Index-Repo wird **mit jeder Version** gestellt — erst nach dem Merge wechselt der Markt auf die neue Version.

## Schritt 7 ✅ Veröffentlichen (ein Klick)

Mods / Plugins → **Mod veröffentlichen** (die Knöpfe „Zur Prüfung einreichen / Erneut einreichen“ auf der Karte unter „Meine Mods“ öffnen denselben Dialog):

1. **Mod auswählen**: in der Liste stehen **nur deine eigenen Mods** (fremde erscheinen nicht, um Fehleingaben zu vermeiden)
2. **Versionsnummer** und **Änderungsnotizen** eintragen (die Notizen gehen in Index und PR — schreib sie in normalen Worten)
3. **Kategorie / Tags** prüfen; **Quell- / Projektadresse** ⭕ optional (z. B. `https://github.com/du/dein-mod`), **GitHub-Releases-Direktlink** ⭕ leer lassen (die richtige Adresse wird beim Veröffentlichen erzeugt)
4. Die drei Erklärungen ankreuzen (eigenes Werk / kein Schadcode / Regeln und Bedingungen gelesen)
5. **Veröffentlichen** klicken

Der Knopf „Veröffentlichen“ wird erst aktiv, wenn die Voraussetzungen oben im Dialog erfüllt sind: **Anzeigename** (Schritt 2), **GitHub-Token** (Schritt 3), **30 Minuten zwischen zwei Einreichungen desselben Mods**, **60 Sekunden zwischen zwei Veröffentlichungen**. Was fehlt, wird gelb hervorgehoben und bekommt einen passenden Einstieg.

### Die vier Phasen im Fortschritt

| Phase | Was sie tut | Wo |
| --- | --- | --- |
| Paket lokal packen | Neu signieren → ZIP packen → SHA256 berechnen → Markt-Manifest erzeugen | **Nur lokal**: kein Netz, kein Token |
| Dein Quell-Repo vorbereiten | Legt ein öffentliches Repo an, falls keines existiert | Dein GitHub |
| Release veröffentlichen und Paket hochladen | Schreibt `evejs-mod.json` (das liest der Markt) → legt das Release an (tag = `v<Version>`) → lädt `<id>-<Version>.zip` hoch | Dein GitHub |
| Versionsprüf-PR stellen | PR ans Index-Repo: beim ersten Mal zusätzlich `sources.json` (Registrierung), danach je Version nur `mods/<id>.json` | Index-Repo `diguo520/EVEjs-mods` |

Artefakte und Verzeichnis:

| Artefakt | Ort |
| --- | --- |
| ZIP-Paket | `_launcher/temp/export-<id>-<version>.zip` (dieselbe Datei liegt auch in deinem Release) |
| Einreichungsverzeichnis | `_launcher/data/my-submissions.json` |

🟨 **Nach Codeänderungen erneut „Veröffentlichen“ klicken**: Sobald sich der Inhalt ändert, wird die Signatur ungültig; der Launcher signiert, packt und pusht dann neu.

### 🔧 Häufige Fehler in diesem Schritt

| Fehler | Ursache | Lösung |
| --- | --- | --- |
| 🟥 `403 Resource not accessible by personal access token` | Token ist fine-grained, oder classic ohne public_repo | classic-Token mit **public_repo** verwenden; das Index-Repo gehört dem Maintainer, ein Fine-grained-Token kommt nicht heran. Wer schon Mitarbeiter des Index-Repos ist: Fine-grained-Token mit `EVEjs-mods` + Contents / Pull requests = Read and write |
| 🟥 `net::ERR_INVALID_ARGUMENT` | Bug beim ZIP-Upload alter Launcher | auf **0.1.20+** aktualisieren |
| 🟥 `404` | Repo existiert nicht, oder das Token deckt es nicht ab | Schreibweise owner/repo prüfen; classic-Token verwenden (public_repo / repo) |
| 🟥 `GitHub-Token noch nicht hinterlegt` | Token nicht gespeichert | zurück zu Schritt 3.5 |

🟩 **Nach dem Erfolg**: Der Dialog zeigt Repo- und Release-Adresse (kannst du öffnen und das ZIP prüfen), die Karte wechselt auf **In Prüfung**.

### Prüfung und Merge

- Der Maintainer prüft deinen Mod in der PR (Manifestfelder, Kategorie, ZIP-Ort, Versionsnummer usw.)
- **Bestanden (gemerged)**: Die Index-CI baut sofort neu, der Markt wechselt auf deine Version, alle Launcher können sie finden
- **Nicht bestanden**: Der Maintainer antwortet in der PR; in **Meine Mods** wird die Karte rot und nennt den **Ablehnungsgrund**

🟨 **Derselbe Mod darf nur alle 30 Minuten eingereicht werden**: Mehrfachklicks würden das Release doppelt pushen und dieselbe PR immer wieder auffrischen; der Dialog zeigt die Restzeit, und bis dahin ist der Knopf grau.

🟦 Nach dem Einreichen **prüft der Launcher die PR noch einmal** und bestätigt, dass sie wirklich offen ist, und schreibt Nummer und Status ins Verzeichnis:
Die Karte unter „Meine Mods“ zeigt `In Prüfung / Gemerged / PR geschlossen` (dieser Status wird höchstens alle 30 Minuten nachgesehen, damit GitHub nicht unnötig belastet wird).

---

## Schritt 8 🟩 Neue Version veröffentlichen (Version ändern → erneut „Veröffentlichen“)

1. Version ändern: `"version"` in `mods/<id>/evejs-launcher.mod.json` bearbeiten (z. B. `1.0.1`)
   🟨 Du kannst auch in **Mod erstellen** mit derselben id neu erzeugen — aber **ändere die id nicht**
2. Mods / Plugins → **Mod veröffentlichen** → deinen Mod wählen → Version und Notizen eintragen → **Veröffentlichen**
   (gleiches Repo, neuer Tag `v1.0.1`, neues ZIP `<id>-1.0.1.zip`; derselbe Branch `release/<id>` frischt die PR auf)

🟨 **Warum die Version hochzählen muss**: Der Markt entscheidet anhand der Versionsnummer, ob es etwas Neues gibt; bleibt sie gleich, melden fremde Launcher kein Update.

🟦 **Warum der ZIP-Dateiname die Version enthält**: jsDelivr cached Branch-Referenzen bis zu etwa 12 Stunden; ein neuer Dateiname trifft den alten Cache nicht.

---

# Teil 4: Prüfung, Delisting und Wiederherstellung

## Wie der Maintainer prüft

| Prüfpunkt | Anforderung |
| --- | --- |
| Repo-Zugehörigkeit | Muss dein eigenes Repo sein |
| Manifest-Vollständigkeit | `id` / `displayName` / `version` / `author{id,name,keyId,publicKey}` / `sizeBytes` / `sha256` (64 Hex-Zeichen) / `downloadUrls[]` |
| ZIP-Ort | In **deinem eigenen Release** (das Index-Repo speichert keine Binärdateien) |
| Kategorie | Eine von fünf: Gameplay / Wirtschaft / KI / Grafik / Werkzeuge |
| Harte Zuordnungsregel | `id`: wer zuerst kommt, mahlt zuerst; `author.id` ist an den Schlüssel gebunden (Schlüsselwechsel wird abgelehnt) |
| Server-Quellcode-Patches | Mods, die Serverdateien ändern, müssen `__evejsMods.register` nutzen (Anhang G); wer selbst `Module.prototype._compile` einhängt, muss nachbessern — mehrere Mods mit eigenen Hooks verdrängen sich gegenseitig |

## Wo du das Prüfergebnis siehst

Launcher → Mods / Plugins → **Meine Mods**:

| Kartenstatus | Bedeutung | Was du tun kannst |
| --- | --- | --- |
| 🟩 Im Markt | Schon aufgenommen | Einfach eine neue Version veröffentlichen |
| 🟨 Update möglich / lokal neuer als im Markt | Deine lokale Version ist neuer | Schritt 8 folgen |
| 🟧 Delisted | Vom Maintainer entfernt | Auf der Karte steht der **Delisting-Grund**; nach dem Beheben **Zur Prüfung erneut einreichen** |
| 🟥 Abgelehnt | Prüfung nicht bestanden | Auf der Karte steht der **Ablehnungsgrund**; nach dem Beheben **Zur Prüfung erneut einreichen** |
| ⬜ Nur lokal / einzureichen | Noch nicht veröffentlicht | Schritt 7 folgen |

🟦 **Meine Mods** zeigt nur Einträge, bei denen „der Mod lokal noch existiert oder im Markt noch installierbar ist“; ist der lokale Ordner gelöscht, verschwinden reine Prüfungs-Einträge automatisch (die Titelleiste weist auf „N ausgeblendet“ hin).

---

# Anhang: die wichtigsten Punkte (🟥 dieser Abschnitt genügt zum Nachschlagen)

| # | Punkt | Folge |
| --- | --- | --- |
| 1 | 🟥 Reiche fremde Mods nicht als deine ein (`author.id`, das nicht deins ist, wird vom Hauptprozess direkt abgelehnt) | Einreichen scheitert |
| 2 | 🟥 `.eve-key` / privater Schlüssel: nie weitergeben, nie committen, nie ins ZIP | Identitätsdiebstahl — oder du verlierst endgültig die Update-Fähigkeit |
| 3 | 🟥 Serverdateien nicht auf der Platte ändern | Fremdes `server/` direkt zu ändern lässt sich nicht installieren / bricht beim ersten Update; für Änderungen im Speicher `__evejsMods.register` nutzen (Anhang G) |
| 4 | 🟥 Im Loader keine Server-Großmodule `require`n | Node-Speicher explodiert |
| 5 | 🟨 Die Versionsnummer darf nur steigen | Andere bekommen kein Update |
| 6 | 🟨 Nach Codeänderungen erneut „Veröffentlichen“ (neu signieren, packen, pushen laufen automatisch) | Signatur ungültig / der Markt behält das alte Paket |
| 7 | 🟨 Die `id` nach dem Anlegen nicht ändern | Bei alten Nutzern wird daraus „deinstallieren + neu installieren“ |
| 8 | 🟨 Der ZIP-Dateiname enthält die Version | Sonst kann der CDN-Cache ein altes Paket liefern |
| 9 | 🟨 Nur die fünf festen Kategorien verwenden | In den Marktfiltern nicht sichtbar |
| 10 | 🟦 Den Loader nur einmal installieren (`globalThis`-Prüfung) | Sonst doppelte Registrierungen und Nachrichten |

---

# Anhang A: vollständige Manifest-Feldtabelle (`evejs-launcher.mod.json`)

| Feld | Pflicht | Typ | Erklärung |
| --- | --- | --- | --- |
| `schemaVersion` | ✅ | number | Fest `3` |
| `id` | ✅ | string | Mod-Kennung, ≤128 Zeichen, keine Pfadtrenner, `a-z0-9-` empfohlen |
| `displayName` | ✅ | string | Anzeigename, ≤100 Zeichen |
| `version` | ✅ | string | Versionsnummer, ≤64 Zeichen, z. B. `1.0.0` |
| `kind` | ✅ | string | `loader` (nutzbar) / `settings` / `client-package` / `source-integrated` (spätere Versionen) |
| `restart` | ✅ | string | `none` / `client` / `game_server` / `launcher` |
| `activation.strategy` | ✅ | string | `loader_rename` |
| `description` | ⭕ | string | Kurzbeschreibung, ≤1000 Zeichen (erscheint auf der Marktkarte) |
| `category` | 🟩 | string | Gameplay / Wirtschaft / KI / Grafik / Werkzeuge |
| `tags` | ⭕ | string[] | Tags |
| `author` | ✅ | object | `{ id, name, keyId, publicKey }` (schreibt der Launcher automatisch) |
| `requires` / `loadAfter` / `loadBefore` / `conflicts` | ⭕ | string[] | Abhängigkeiten und Konflikte (Mod-IDs eintragen) |
| `compatibility.evejsVersions` | ⭕ | string[] | Kompatible EveJS-Versionen, z. B. `["0.12.8"]` |
| `signature` | ✅ | object | Signatur (erzeugt der Launcher automatisch) |

# Anhang B: ein lauffähiges Loader-Grundgerüst

Das ist die **kompakte Fassung** des Gerüsts aus „Mod erstellen“ — alle vier harten Regeln sind enthalten, anpassen und loslegen (die vollständig kommentierte Fassung steht in `mods/<deine Mod-id>/loader.js`):

```js
"use strict";
const path = require("path");

const TAG = "[mein-mod]";
const MOD_ID = "my-mod";
const POLL_MS = 3000;
const GRACE_MS = 10000;                      // so lange nach dem Login warten: die Session muss erst bereit sein
const MESSAGE = "Willkommen zurück, Pilot!";

// Diesen Block öffnen, wenn Servercode geändert werden soll (neuer Mechanismus: über den Bus melden, nur anhängen):
//   target —— relativ zur EveJS-Wurzel, mit Schrägstrichen
//   marker —— eindeutige Markierung; ist sie schon vorhanden, überspringt der Bus die Schicht (idempotent)
//   slot   —— Reihenfolge mehrerer Schichten für dieselbe Datei, kleiner = früher (Vielfache von 10 empfohlen)
//   append —— nur angehängter Code, nie die ganze Datei neu schreiben
const SOURCE_PATCH = null;
// const SOURCE_PATCH = {
//   target: "server/src/network/tcp/handshake.js",
//   marker: "// my-mod:patch",
//   slot: 40,
//   append: "// my-mod:patch\nconsole.log('[my-mod] patched');",
// };

console.log(TAG + " preload ausgeführt · pid=" + process.pid);

/** Nur im echten Serverprozess weitermachen (npm / Wrapper-Prozesse ausschließen) */
function isRealServerProcess() {
  if (process.env.EVEJS_GAMESTORE_OWNER_ROLE === "world") return true;
  const entry = (require.main && require.main.filename) || process.argv[1] || "";
  return /(^|[\\/])index\.js$/i.test(entry);
}

/** Den Quellcode-Patch am Injektionsbus registrieren (🟥 muss synchron laufen, siehe unten) */
function registerSourcePatch() {
  if (!SOURCE_PATCH || !SOURCE_PATCH.target) return;
  const bus = globalThis.__evejsMods;
  if (!bus || !(Number(bus.api) >= 1)) {
    console.log(TAG + " alter Launcher ohne Injektionsbus, Quellcode-Patch übersprungen");
    return;
  }
  bus.register({
    id: MOD_ID,
    target: SOURCE_PATCH.target,
    marker: SOURCE_PATCH.marker,
    slot: SOURCE_PATCH.slot,
    apply: (source) => source + "\n" + SOURCE_PATCH.append + "\n",
  });
}
// 🟥 Synchron registrieren: Der Server requiret die Zieldateien schon beim Start,
//    eine Registrierung in setImmediate kommt zu spät (die Datei ist dann bereits kompiliert, der Patch wirkt nicht)
registerSourcePatch();

setImmediate(() => {
  if (!isRealServerProcess()) return;
  if (globalThis.__myModStarted) return;      // 🟨 wird mehrfach geladen: nur einmal installieren
  globalThis.__myModStarted = true;
  start();
});

function start() {
  // 🟥 require("./src/...") ist relativ zu DEINEM Mod-Verzeichnis, nicht zur Serverwurzel — erst die Wurzel berechnen
  const serverRoot = path.resolve(__dirname, "..", "..", "server");
  const hubPath = path.join(serverRoot, "src", "services", "chat", "chatHub.js");
  const registryPath = path.join(serverRoot, "src", "services", "chat", "sessionRegistry.js");

  // 🟨 Warte, bis der Server diese beiden Module selbst in require.cache hat, und nimm dann die
  //    Referenz: Cache-Treffer, kein zusätzlicher Speicher, kein vorzeitig geladener 456-MB-Modulgraph
  const timer = setInterval(() => {
    if (!require.cache[require.resolve(hubPath)]) return;
    if (!require.cache[require.resolve(registryPath)]) return;
    clearInterval(timer);
    run(require(require.resolve(hubPath)), require(require.resolve(registryPath)));
  }, 500);
  timer.unref();
}

function run(chatHub, sessionRegistry) {
  const seen = new Set();
  const firstSeenAt = new Map();

  const timer = setInterval(() => {
    let sessions;
    try {
      sessions = sessionRegistry.getSessions() || [];
    } catch {
      return;
    }

    const now = Date.now();
    const online = new Set();

    for (const session of sessions) {
      const characterID = sessionRegistry.resolveSessionCharacterID(session);
      if (!characterID) continue;              // noch nicht wirklich im Spiel, nächste Runde abwarten
      online.add(characterID);
      if (!firstSeenAt.has(characterID)) firstSeenAt.set(characterID, now);
      if (seen.has(characterID)) continue;
      if (now - firstSeenAt.get(characterID) < GRACE_MS) continue;

      try {
        // Manche Session-Objekte tragen nur charid in Kleinschreibung: einmal ergänzen, damit nichts „still nicht gesendet“ wird
        if (!Number(session.characterID || 0)) session.characterID = characterID;
        chatHub.sendSystemMessage(session, MESSAGE);
        seen.add(characterID);
        console.log(TAG + " Nachricht an Charakter " + characterID + " gesendet");
      } catch (error) {
        console.log(TAG + " Charakter " + characterID + " noch nicht bereit, später erneut: " + error.message);
      }
    }

    // Offline gegangene Charaktere aufräumen; beim nächsten Login wird es erneut ausgelöst
    for (const id of Array.from(seen)) if (!online.has(id)) seen.delete(id);
    for (const id of Array.from(firstSeenAt.keys())) if (!online.has(id)) firstSeenAt.delete(id);
  }, POLL_MS);
  timer.unref();
}
```

🟨 Die oben genutzten Serverschnittstellen sind **in der Praxis erprobt**:

| Schnittstelle | Zweck |
| --- | --- |
| `sessionRegistry.getSessions()` | Array der Online-Sessions (🟥 **nicht** `list()`, diese Methode gibt es nicht) |
| `sessionRegistry.resolveSessionCharacterID(session)` | Liefert die Charakter-ID (0, solange nicht im Spiel) |
| `chatHub.sendSystemMessage(session, "Nachricht")` | Sendet eine Systemnachricht im lokalen Kanal dieses Charakters |

Schnittstellen können sich je EveJS-Version ändern — maßgeblich sind die tatsächlichen Exporte deiner Version.

# Anhang C: Konflikte und Ladeordnung

| Typ | Wie er entsteht | Folge |
| --- | --- | --- |
| Erklärter Konflikt | Im Manifest verweisen `conflicts` gegenseitig aufeinander | Die beiden Mods werden nicht gleichzeitig aktiviert |
| Doppelte `id` | Zwei Manifeste nutzen dieselbe `id` | Nur einer wird geladen |
| Gemeinsames Servermodul | Mehrere Loader referenzieren dasselbe Servermodul | Sie können sich gegenseitig beeinflussen (der Launcher weist darauf hin) |
| Fehlende Abhängigkeit | Der Mod aus `requires` ist nicht installiert | Dieser Mod wird nicht geladen |

🟦 Ladereihenfolge: Im Reiter **Installiert** Karten per **Drag & Drop** sortieren oder oben links „⤓ ans Ende verschieben“ nutzen. Die Liste ist gruppiert - aktive Mods zuerst, deaktivierte danach -, jede Gruppe in deiner Reihenfolge: Ein Mod abzuschalten erfordert kein Neusortieren, beim Wiederaktivieren kehrt er an seinen Platz zurück.
🟨 `loadAfter` / `loadBefore` im Manifest haben **Vorrang** und justieren die gezogene Reihenfolge nach; ein verschobener Mod wird im Panel „Ladereihenfolge“ als „durch Manifest-Regel verschoben“ markiert.
🟦 Das Panel „Ladereihenfolge“ zeigt die **tatsächlich wirksame** Reihenfolge sowie die Mods, die **diesmal nicht geladen** werden (Manifest defekt / Abhängigkeit fehlt / Konflikt / kein loader.js) und die Reihenfolge-Erklärungen **ohne Wirkung** (Ziel nicht installiert oder deaktiviert, Ordner aus der gespeicherten Reihenfolge verschwunden). Änderungen wirken erst nach einem **Serverneustart**.

## 🟥 Mehrere Mods ändern dieselbe Serverdatei (der neue Launcher hat eine Lösung)

Wenn ein Mod **selbst `Module.prototype._compile` einhängt**, um Servercode zu ändern, wird es bei zwei Mods auf derselben Datei problematisch:

- Wer die Originaldatei zuerst sieht, hängt völlig von der Ladeordnung ab;
- prüft einer per „sha256 der ganzen Datei“, **scheitert** die Prüfung, weil der andere schon Inhalt angehängt hat;
- der real beobachtete Fall: `automatischer Bergbau` und `automatisches Anvisieren + Feuern` hängten beide Code an das Ende von `server/src/network/tcp/handshake.js`; der zuerst injizierte schrieb, der zweite sah einen abweichenden Hash und **gab still auf** (kein Fehler, keine Wirkung).

🟩 Der neue Launcher bietet dafür einen **Injektionsbus**: Die Mods hängen nicht mehr einzeln ihre Hooks ein, sondern melden per `__evejsMods.register` „welche Datei, welcher Zusatz“; der Bus verkettet die Schichten nach `(slot, Registrierungsreihenfolge)` — jede Schicht sieht den Inhalt, **den die vorige hinterlassen hat**. Siehe **Anhang G**.

# Anhang D: ZIP-Aufbau und Importregeln

### ZIP-Aufbau (beide Varianten möglich, Variante 2 empfohlen)

```text
Variante 1: Manifest direkt im Wurzelverzeichnis   Variante 2: ein einzelner Ordner darum (empfohlen)
my-mod.zip                                          my-mod.zip
├── evejs-launcher.mod.json                          └── my-mod/
├── loader.js.disabled                                   ├── evejs-launcher.mod.json
└── README.md                                            ├── loader.js.disabled
                                                          └── README.md
```

Der Launcher findet die Paketwurzel automatisch; ein ZIP mit **mehreren** Mod-Paketen wird abgelehnt (ein Import pro Vorgang).

### Regeln, wenn andere dein ZIP importieren

| Regel | Erklärung |
| --- | --- |
| Installationsort | `<EveJS-Wurzel>/mods/<Manifest-id>` (ungültige Zeichen der id werden zu `-`) |
| Anfangszustand | **Zwangsweise deaktiviert** (`loader.js` wird wieder `loader.js.disabled`), der Nutzer schaltet manuell ein |
| Namenskonflikt | Ein gleichnamiger Ordner unter `mods/` → Import abgelehnt mit Hinweis |
| Manifest fehlt | Kein `evejs-launcher.mod.json` im ZIP → abgelehnt |

### 🟨 Größe

Die Mod-Seite **zählt den Platzbedarf jedes Mods rekursiv**. Packe nur die zum Betrieb nötigen Dateien — 🟥 keine Quell-Repos, kein `node_modules`, keine Screenshots, kein `.git` ins ZIP.

# Anhang E: wie der Loader injiziert wird

🟩 **Heute (über den Injektionsbus)**: Der Launcher legt nur **ein** `--require "<vom Launcher mitgelieferte mod-host.js>"` in `NODE_OPTIONS`; dein `loader.js` wird vom Bus in der Reihenfolge aus `_launcher/mods/mod-plan.json` `require`t. Der Mod-Ordnername darf daher Nicht-ASCII-Zeichen oder Leerzeichen enthalten; im Launcher-Log bedeutet `[EveJS-MOD] loaders-done total=N failed=0 ms=X`, wie viele Millisekunden das Laden aller Mods gedauert hat.

🟨 **Das Folgende ist die alte Schreibweise „ein `--require` pro Loader“** (heute nur noch Rückfalllösung, falls das Schreiben des Bus-Plans scheitert): Der Launcher injiziert dein `loader.js` über `NODE_OPTIONS=--require ...` von Node in den Serverprozess. Deshalb gilt:

- 🟥 **Backslashes werden als Escapes verschluckt** → aus `C:\mods\x\loader.js` wird `C:modsxloader.js`
- 🟨 `NODE_OPTIONS` trennt an Leerzeichen, **Pfade mit Leerzeichen müssen in Anführungszeichen stehen**

Richtig ist „Pfade in Schrägstriche umwandeln + in doppelte Anführungszeichen setzen“ — genau so setzt es der Launcher intern zusammen (in der Praxis erprobt):

```js
const requireArgs = paths.map((p) => '--require "' + p.replace(/\\/g, "/") + '"').join(" ");
```

🟦 Du **musst** das nicht selbst bauen — merk dir nur „ins Mod-Verzeichnis gehören keine Nicht-ASCII-Zeichen und keine Leerzeichen“, dann passt es beim Fehlersuchen zusammen.

# Anhang F: Checkliste vor der Veröffentlichung

- [ ] Der Mod lässt sich lokal aktivieren und wirkt (in Schritt 6 getestet)
- [ ] Mods, die Servercode ändern, laufen über `__evejsMods.register` (Anhang G) und hängen sich nicht selbst in `_compile`
- [ ] `id` / `version` / `category` in `evejs-launcher.mod.json` stimmen
- [ ] Die Versionsnummer ist **größer als in der Vorversion**
- [ ] `.eve-key` ist gesichert (für den Rechnerwechsel nötig)
- [ ] In `mods/<id>/` liegen weder private Schlüssel noch lokale Pfade oder andere private Inhalte
- [ ] **Mod veröffentlichen** wurde geklickt, alle vier Phasen sind durch, und das ZIP ist auf deiner Release-Seite anklickbar
- [ ] Die Prüf-PR dieser Version im Index-Repo **wurde gemerged** (nicht gemerged = der Markt bleibt auf der Vorversion)


# Anhang G: Servercode ändern — der Injektionsbus `__evejsMods.register`

🟨 Nur Mods, die **wirklich Servercode ändern müssen**, brauchen diesen Abschnitt. Ein Mod wie „Begrüßung beim Login“, der nur Server-APIs aufruft, kommt mit Anhang B aus.

Der Bus wird vom Launcher injiziert; auf Mod-Seite genügt eine Deklaration am Dateiende:

```js
const bus = globalThis.__evejsMods;
if (bus && bus.api >= 1) {
  bus.register({
    id: "deine Mod-id",                             // gleich wie die id im Manifest, dient als Markierung im Bericht
    target: "server/src/network/tcp/handshake.js",  // relativ zur EveJS-Wurzel, mit Schrägstrichen
    marker: "MY_MOD_MARK",                         // eindeutige Markierung: schon injiziert = Schicht wird übersprungen (idempotent)
    slot: 10,                                      // Reihenfolge mehrerer Schichten derselben Datei, kleiner = früher
    apply: (source) => source + "\n// MY_MOD_MARK\n// hier steht der anzuhängende Code\n",
  });
} else {
  // alter Launcher ohne Bus: notfalls auf einen eigenen Hook zurückfallen oder gar nichts injizieren
}
```

Vier Regeln (🟥 eine verletzt, und andere Mods fallen ohne erkennbaren Grund aus):

| Regel | Warum |
| --- | --- |
| Nur `register` nutzen, **nicht** selbst `Module.prototype._compile` einhängen | Ein eigener Hook führt zurück zum „Kampf um den Injektionspunkt“, und der Bus sieht deine Änderungen nicht |
| `apply` **hängt nur an**; nichts umschreiben oder löschen | Die folgenden Schichten müssen dein Ergebnis weiter anhängen können |
| Einen `marker` wählen, den sonst niemand nutzt | Der Bus erkennt daran, ob schon injiziert wurde; ein Neustart stapelt nichts |
| Beim Prüfen den **Präfix vor der Änderung** (oder die Länge) prüfen, nicht den sha256 der ganzen Datei | Ein Vollhash kann in einer mehrschichtigen Kette nie passen — das sperrt dich selbst aus |

🟩 Ergebnis ablesen: Im Log heißt `[EveJS-MOD] <Datei> N Schichten injiziert (A -> B Bytes)`, dass diese Schicht gewirkt hat; `[EveJS-MOD] <id> Patch fehlgeschlagen, Ergebnis der vorherigen Schicht bleibt: <Grund>` heißt, dass diese Schicht übersprungen wurde (**ohne** Einfluss auf andere Mods).

---

**Dokumentversion**: wird mit dem Launcher aktualisiert (synchron zu `_launcher/mods/MOD_AUTHORING.de.md` im Launcher).
Bei einem hier nicht beschriebenen Fall zuerst das **Server-Log** im Launcher und die roten Hinweise auf den Karten ansehen und dann mit dem Log den Maintainer fragen.
