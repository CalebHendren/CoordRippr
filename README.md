# CoordRippr 🌐⚔️

**Rip coordinate data out of PDFs.** Point CoordRippr at a folder of PDFs (journal
articles, reports, field notes — two-column layouts welcome) and it scans every
page for anything that remotely resembles a latitude/longitude, highlights the
hits on the page, and builds a clean, editable CSV.

[![Ko-fi](https://img.shields.io/badge/Ko--fi-support%20development-ff5e5b?logo=kofi&logoColor=white)](https://ko-fi.com/calebhendren)

If CoordRippr saves you time, consider [buying me a coffee on Ko-fi](https://ko-fi.com/calebhendren) ☕

## Features

- **Projects** — keep several jobs going at once. Each project has its own
  PDFs, rows, column headers and settings; switch between them from the
  toolbar (`＋` new, `✎` rename, `🗑` delete). Everything is saved per project.
- **Resume where you left off** — CoordRippr snapshots your session (files,
  extracted rows, edits, format, zoom, deletions) to local storage as you
  work, so closing and reopening the app drops you back exactly where you
  were — dropped-in PDFs and all. (Uses IndexedDB; if a browser blocks it,
  the app still runs, just without saving.)
- **Batch scanning** — open a folder and every PDF in it (recursively) is scanned.
  Individual file picking and drag & drop work too.
- **Extremely wide detection net** — DD (`41.40338, 2.17403`) and DMS
  (`41°24'12.2"N`) in all their degenerate forms:
  - `o` or `O` standing in for the degree symbol (`12o30'N`)
  - any tick mark for minutes/seconds: `'` `′` `’` `` ` `` `´`, `"` `″` `”`, doubled ticks
  - hemisphere as letters (`N`, `s`) or words (`South`, `West`), leading or trailing
  - `Lat.` / `Long.` labels, space-separated DMS (`40 26 46 N`), decimal commas
  - coordinates broken across **line breaks** — even when a pair straddles a
    **page boundary** (latitude at the foot of one page, longitude at the top
    of the next)
- **Dynamic detection net (regex intensity)** — a toolbar slider from
  *Strict* to *Everything* controls how aggressive the parser is. Turn it down
  when a document is full of numbers that look like coordinates but aren't;
  turn it up to catch bare decimal or even integer pairs. Moving the slider
  re-scans the loaded PDFs in place — your edits, filled columns and deletions
  are preserved.
- **Focused page view** — only pages containing detections are shown
  (toggle *Show all pages* to see everything). Every hit is highlighted;
  the *Highlights* toggle hides the yellow boxes when they get in the way
  of reading the page.
- **Two-way jumping** — click a CSV row to jump to the highlight in the PDF;
  click a highlight in the PDF to jump to its CSV row.
- **Editable CSV preview** with header row:
  - columns 1–2 are yours (headers editable); latitude/longitude live in
    columns 3–4
  - output as **DD**, **DMS**, or **Both** (DD in columns 3/4, DMS in 5/6) —
    regardless of what the source PDF used
  - anything you type into a coordinate cell is **auto-cleaned** to the chosen
    format; unparseable input is kept but flagged red
  - mass-entry for columns 1/2: fill a row range (e.g. rows 2–23) or the
    current selection in one click; `Ctrl+D` copies the cell above
  - row selection (shift/ctrl click the row numbers), add/delete rows
  - **remove duplicate coordinates** (*Remove Duplicates…*) with a live count
    before you commit — optionally only when columns 1–2 (e.g. Genus/Species)
    also match, and/or only when the rows come from the same PDF
- **CSV export** with UTF-8 BOM (Excel-safe degree symbols).
- **✨ LLM Assist (bring your own API key)** — optionally send the PDF text to an
  LLM to *verify* the extracted coordinates and *fill columns 1–2* from the
  surrounding text (e.g. if a paper describes animals, put the animal in
  column 1 and its colour in column 2 — rename the column headers and/or add
  prompt instructions to tell it what you want):
  - Providers: Anthropic (Claude), OpenAI, Google Gemini, DeepSeek,
    Qwen (Alibaba), Kimi (Moonshot), GLM (Zhipu), or any custom
    OpenAI-compatible endpoint. Your key is stored locally and sent only to
    the provider you pick. A **Get an API key** link next to the key field
    opens the chosen provider's key page (e.g. *DeepSeek Platform*).
  - Each provider has a **model dropdown** pre-filled with current models
    (e.g. Claude → Haiku, Sonnet, Opus, Fable), plus a **Custom…** option to
    type any other model ID.
  - Choose to send only the pages with detected coordinates, or the full PDFs.
  - **Parallel requests** — send several requests at once (a bounded pool, set
    how many in the dialog; `1` = one at a time). This is a big speed-up with
    **One request per page**, which fans a PDF out into many small independent
    requests; turn it down if a provider rate-limits you.
  - Rows get a verdict badge: ✓ confirmed, ⚠ mismatch (click to apply the
    suggested correction), ? not found.
  - **False-positive flagging** — optionally let the LLM mark rows that
    aren't really coordinates (dates, measurements, page numbers…). They get a
    🗑 flag you can review and remove one-by-one or with *Delete Flagged*.
    There's also an explicit, opt-in **automatic deletion** mode that removes
    flagged rows with no confirmation — powerful but **dangerous**, because a
    wrong flag silently discards a real coordinate. It resets every run and
    asks you to confirm before starting.
  - ⚠️ **Use at your own risk.** LLMs make mistakes and invent details.
    Nothing it returns is ground truth — always verify against the PDFs.
- **Daily update check** (plus a *Check for updates* button in the footer) —
  compares against the latest GitHub release and links you there; nothing is
  downloaded automatically.
- **Windows install/uninstall wizard** — the `.exe` is a full NSIS assisted
  installer (license page, install location, desktop/start-menu shortcuts,
  clean uninstaller in *Apps & features*).

## Download

Grab the latest build from the [Releases](../../releases) page:

| Platform | File |
| --- | --- |
| Windows | `CoordRippr-<version>-win-x64.exe` (NSIS installer) |
| macOS | `CoordRippr-<version>-mac-<arch>.dmg` |
| Ubuntu / Debian | `CoordRippr-<version>-linux-amd64.deb` |
| Fedora / RHEL | `CoordRippr-<version>-linux-x86_64.rpm` |
| Arch | `CoordRippr-<version>-linux-x64.pacman` |

Builds are produced by the [GitHub Actions workflow](.github/workflows/build.yml).
A release with all installers attached is created automatically whenever the
`version` in `package.json` is bumped and merged to `main` (the workflow tags
`v<version>` and publishes it once). Pushing a `v*` tag by hand still works too.

### Web version (GitHub Pages)

CoordRippr is plain JS under the hood, so it also runs entirely in the
browser — no install, nothing uploaded (PDFs are processed locally in the
page): **https://calebhendren.github.io/CoordRippr/**

The [Pages workflow](.github/workflows/pages.yml) deploys it on every push to
`main` (first run needs GitHub Pages enabled for the repo — the workflow
attempts to enable it automatically; otherwise set *Settings → Pages → Source*
to "GitHub Actions"). Web-version caveats:

- Folder picking uses the File System Access API (Chrome/Edge); other browsers
  fall back to a folder-upload prompt. Drag & drop works everywhere.
- LLM Assist calls the provider straight from the browser, which some
  providers restrict via CORS. Anthropic, OpenAI, and Gemini work; some others
  may only work from the desktop app.

## Usage

1. **Open Folder…** (or *Open PDFs…* / drag files in). Scanning starts
   immediately; the file list shows a hit count per PDF. Working on more than
   one job? Spin up a separate **Project** for each — they're kept apart and
   saved automatically, and you'll land back in the last one next launch.
2. Review the right panel: only pages with detections are shown, hits are
   highlighted yellow. Hover a highlight to see the raw matched text. If the
   parser is too greedy or too shy, drag the **Net** slider and it re-scans.
3. Fill in columns 1–2 (site names, notes, …). For repeated values use the
   *Fill* bar: pick the column, a row range, a value → *Apply*.
4. Pick the coordinate output format in the toolbar (DD / DMS / Both).
5. Fix anything the parser got wrong — edits are auto-cleaned — and delete
   false positives (the net is wide on purpose).
6. Optional: **✨ LLM Assist…** — pick a provider, paste your API key, describe
   what columns 1–2 should contain, and let it verify coordinates and fill the
   columns. Then check its work; it's an assistant, not an oracle.
7. **Export CSV…**

> **Note:** detection works on the PDF *text layer*. Scanned/image-only PDFs
> have no text to search — run OCR on them first.

## Development

```bash
npm install        # needs network access to download Electron
npm test           # parser/LLM/update unit tests + pdf.js integration test
npm start          # run the app
npm run web        # build the static browser version into dist-web/
npm run dist       # package for the current platform
```

Useful bits:

- `src/coords.js` — the tokenizer/parser/formatter, the intensity levels, and
  `extractCrossPage()`. Start here to widen the net further.
- `src/persist.js` — IndexedDB-backed projects and session snapshots
  (`packState`/`unpackState` are pure and unit-tested).
- `src/pdftext.js` — pdf.js text items → searchable string + match-to-rectangle mapping.
- `tools/make-sample-pdf.mjs` — regenerates `test/fixtures/sample.pdf` (the messy two-column test document).
- `build/icon.svg` — icon source; rasterize with:
  ```bash
  npm i --no-save sharp
  node -e "require('sharp')('build/icon.svg').resize(1024,1024).png().toFile('build/icon.png')"
  ```

## License

MIT — see [LICENSE](LICENSE).
