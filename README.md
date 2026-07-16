# CoordRippr 🌐⚔️

Coordinates love to hide in PDFs — tucked into a sentence, stranded in a table,
split down the middle of a two-column journal article. CoordRippr digs them out.
Point it at a folder of PDFs and it reads every page, finds anything shaped like
a latitude/longitude, boxes the matches on the page, and hands you a CSV to tidy
up and export.

[![Ko-fi](https://img.shields.io/badge/Ko--fi-support%20development-ff5e5b?logo=kofi&logoColor=white)](https://ko-fi.com/calebhendren)

If it saves you an afternoon of retyping numbers by hand, you can
[buy me a coffee](https://ko-fi.com/calebhendren). ☕

## What it does

**Work in projects.** Each job keeps its own PDFs, rows, headers and settings,
all held separately. Create, rename and delete them from the toolbar (`＋` `✎`
`🗑`). Everything saves as you go, so you can close the app mid-task and reopen
exactly where you left off — dropped-in PDFs and all. (Saving uses IndexedDB; if
your browser blocks it the app still runs, it just won't remember between
sessions.)

**Scan in bulk.** Open a folder and every PDF inside it gets scanned, subfolders
included. Picking individual files or dragging them in works too.

**Catch coordinates that don't want to be caught.** The parser reads decimal
degrees (`41.40338, 2.17403`) and DMS (`41°24'12.2"N`), including the messy
variants that break a naive regex:

- an `o` or `O` standing in for the degree symbol (`12o30'N`)
- whatever the author reached for as a tick — `'` `′` `’` `` ` `` `´`, `"` `″`
  `”`, or doubled marks
- hemispheres as letters (`N`, `s`) or spelled out (`South`, `West`), leading or
  trailing
- `Lat.`/`Long.` labels, space-separated DMS (`40 26 46 N`), decimal commas
- pairs snapped over a line break, or even split across a page — latitude at the
  foot of one page, longitude at the top of the next

You decide how wide to cast the net. A **Strict → Everything** slider sets how
aggressive the parser gets: pull it back on documents full of numbers that only
look like coordinates, push it up to grab bare decimal or integer pairs. Nudge
it and the loaded PDFs re-scan in place, keeping your edits, filled cells and
deletions.

**See the hits in context.** The viewer shows only the pages that matched
something (flip *Show all pages* for the rest) and boxes each hit in yellow.
Hover a box for the raw text behind it; toggle the highlights off when they get
in the way of reading. Click a row in the table to jump to its box in the PDF,
or click a box to jump back to its row.

**Edit the table like a spreadsheet.** Columns 1–2 are yours to fill and rename;
latitude and longitude sit in 3–4. Pick your output — **DD**, **DMS**, or
**Both** (DD in 3/4, DMS in 5/6) — and it's applied regardless of what the
source used. Type into a coordinate cell and it's reformatted to match, or left
alone and flagged red if it can't be parsed. There's range-and-selection fill
for columns 1–2, `Ctrl+D` to copy the cell above, row selection by
shift/ctrl-clicking the row numbers, and add/delete. *Remove Duplicates…* shows
a live count before it commits and can be narrowed to rows that also share
columns 1–2 (the same genus and species, say) or that come from the same PDF.

Export is CSV with a UTF-8 BOM, so Excel keeps the degree symbols intact instead
of turning them into gibberish.

Once a day — or whenever you hit *Check for updates* in the footer — CoordRippr
compares your build against the latest GitHub release and links you to it.
Nothing is ever downloaded on its own.

On Windows the `.exe` is a full NSIS wizard: license page, choice of install
location, desktop and start-menu shortcuts, and a proper uninstaller in *Apps &
features*.

### ✨ LLM Assist

Bring your own API key and you can hand the page text to an LLM to double-check
the coordinates CoordRippr found and to fill columns 1–2 from the surrounding
prose. For a paper about animals, that might be the species in one column and
its colour in the other — rename the headers and add a prompt to point it in the
right direction.

- Works with Anthropic (Claude), OpenAI, Google Gemini, DeepSeek, Qwen, Kimi,
  GLM, or any OpenAI-compatible endpoint you hand it. The key stays on your
  machine and only goes to the provider you picked, and a **Get an API key**
  link drops you on that provider's key page.
- Every provider has a dropdown of current models, plus **Custom…** for any
  other model ID.
- Send only the pages with detections, or the whole PDF.
- Requests can go out several at a time — set the pool size, or `1` for
  one-at-a-time. This pays off most with **one request per page**, which fans a
  PDF into lots of small independent calls. If a provider rate-limits you, turn
  the pool down, or set a **delay between batches** so a fresh batch of N goes
  out on a fixed clock (four pages now, four a second later, and so on) rather
  than the instant the last one comes back.
- Each row returns with a badge: ✓ confirmed, ⚠ mismatch (click to take the
  correction), ? not found.
- You can also ask it to flag rows that smell like false positives — dates,
  measurements, page numbers — with a 🗑 you clear one by one or all at once.
  There's an opt-in **auto-delete** that removes them without asking; it's
  genuinely risky, since one bad flag quietly discards a real coordinate, so it
  resets every run and makes you confirm first.

Worth repeating: LLMs are confident and wrong on a regular basis. Treat anything
it returns as a suggestion and check it against the PDF.

## Download

Latest builds live on the [Releases](../../releases) page:

| Platform | File |
| --- | --- |
| Windows | `CoordRippr-<version>-win-x64.exe` (NSIS installer) |
| macOS | `CoordRippr-<version>-mac-<arch>.dmg` |
| Ubuntu / Debian | `CoordRippr-<version>-linux-amd64.deb` |
| Fedora / RHEL | `CoordRippr-<version>-linux-x86_64.rpm` |
| Arch | `CoordRippr-<version>-linux-x64.pacman` |

The [GitHub Actions workflow](.github/workflows/build.yml) builds them. Bump the
`version` in `package.json`, merge to `main`, and it tags `v<version>` and
publishes a release with every installer attached — once. Pushing a `v*` tag by
hand still works if you'd rather.

### Web version (GitHub Pages)

It's plain JS underneath, so the whole thing also runs in a browser with nothing
to install and nothing uploaded — PDFs are processed right there in the page:
**https://calebhendren.github.io/CoordRippr/**

The [Pages workflow](.github/workflows/pages.yml) redeploys on every push to
`main`. (The first run needs GitHub Pages switched on; the workflow tries to do
that itself, but if it can't, set *Settings → Pages → Source* to "GitHub
Actions".) Two things to know about the browser build:

- Folder picking uses the File System Access API, which only Chrome and Edge
  support; elsewhere you get a folder-upload prompt instead. Drag & drop works
  everywhere.
- LLM Assist calls the provider straight from the page, and some providers block
  that over CORS. Anthropic, OpenAI and Gemini are fine; a few others only work
  from the desktop app.

## Usage

1. **Open Folder…** (or *Open PDFs…*, or drag files in). Scanning starts right
   away and the file list shows a hit count per PDF. Juggling more than one job?
   Give each its own **project** — they stay apart, save themselves, and you'll
   land back in the last one next launch.
2. Look over the right-hand panel: matched pages only, hits boxed in yellow.
   Hover a box for the text it caught. If the parser is grabbing too much or too
   little, drag the **Net** slider and it re-scans.
3. Fill columns 1–2 with site names, notes, whatever you need. For values that
   repeat, use the *Fill* bar — pick the column, a row range, a value, *Apply*.
4. Choose the output format in the toolbar: DD, DMS, or Both.
5. Fix whatever the parser got wrong (edits clean themselves up) and delete the
   false positives — the net is wide on purpose.
6. Optional: **✨ LLM Assist…** — pick a provider, paste a key, say what columns
   1–2 should hold, and let it verify the coordinates and fill the columns.
   Then read its work. It's an assistant, not an oracle.
7. **Export CSV…**

> Detection runs on the PDF's *text layer*. A scanned or image-only PDF has no
> text to search, so run OCR on it first.

## Development

```bash
npm install        # pulls Electron and pdf.js, so it needs network
npm test           # parser / LLM / update unit tests + a pdf.js integration test
npm start          # launch the app
npm run web        # build the static browser version into dist-web/
npm run dist       # package installers for the current platform
```

Where to look:

- `src/coords.js` — the tokenizer, parser, formatter, intensity levels and
  `extractCrossPage()`. This is where you go to widen the net.
- `src/llm.js` — provider presets, prompt building, chunking, and the request
  runners. Pure functions, unit-tested.
- `src/persist.js` — IndexedDB-backed projects and session snapshots
  (`packState`/`unpackState` are pure and tested).
- `src/pdftext.js` — turns pdf.js text items into a searchable string and maps
  matches back to page rectangles.
- `tools/make-sample-pdf.mjs` — regenerates `test/fixtures/sample.pdf`, the
  deliberately messy two-column test document.
- `build/icon.svg` — the icon source. Rasterize it with:
  ```bash
  npm i --no-save sharp
  node -e "require('sharp')('build/icon.svg').resize(1024,1024).png().toFile('build/icon.png')"
  ```

## License

MIT — see [LICENSE](LICENSE).
