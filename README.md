# CoordRippr 🌐⚔️

CoordRippr scans PDFs for latitude/longitude coordinates, highlights the matches
on the page, and exports them as an editable CSV. It handles multi-column
layouts (e.g. journal articles) and coordinate pairs split across lines or page
boundaries.

[![Ko-fi](https://img.shields.io/badge/Ko--fi-support%20development-ff5e5b?logo=kofi&logoColor=white)](https://ko-fi.com/calebhendren)

Support development on [Ko-fi](https://ko-fi.com/calebhendren).

## Features

- **Projects** — Multiple independent projects, each with its own PDFs, rows,
  column headers, and settings. Create, rename, and delete from the toolbar
  (`＋` / `✎` / `🗑`). State is saved per project.
- **Session persistence** — Files, extracted rows, edits, output format, zoom,
  and deletions are snapshotted to local storage as you work and restored on the
  next launch, including drag-and-dropped PDFs. Uses IndexedDB; if it is
  unavailable the app runs without persistence.
- **Batch scanning** — Opening a folder scans every PDF within it recursively.
  Individual file selection and drag-and-drop are also supported.
- **Detection** — Recognizes decimal degrees (`41.40338, 2.17403`) and DMS
  (`41°24'12.2"N`), including common degenerate forms:
  - `o` or `O` substituted for the degree symbol (`12o30'N`)
  - minute/second ticks: `'` `′` `’` `` ` `` `´`, `"` `″` `”`, and doubled ticks
  - hemisphere as a letter (`N`, `s`) or word (`South`, `West`), leading or
    trailing
  - `Lat.` / `Long.` labels, space-separated DMS (`40 26 46 N`), decimal commas
  - pairs split across line breaks, including across a page boundary (latitude at
    the foot of one page, longitude at the top of the next)
- **Detection intensity** — A toolbar slider (*Strict* to *Everything*) controls
  parser aggressiveness. Lower values suppress numbers that resemble coordinates
  but are not; higher values match bare decimal or integer pairs. Changing it
  re-scans the loaded PDFs in place, preserving edits, filled columns, and
  deletions.
- **Page view** — Shows only pages with detections by default (*Show all pages*
  to view the rest). Matches are highlighted; hovering a highlight shows the raw
  matched text; the *Highlights* toggle hides the boxes. Clicking a CSV row
  scrolls to its highlight in the PDF, and clicking a highlight scrolls to its
  CSV row.
- **CSV table** — Editable table with a header row:
  - Columns 1–2 are user-defined (editable headers); latitude/longitude occupy
    columns 3–4.
  - Output as **DD**, **DMS**, or **Both** (DD in columns 3/4, DMS in 5/6),
    independent of the source format.
  - Coordinate cells are reformatted to the selected output on entry;
    unparseable input is retained and flagged.
  - Range/selection fill for columns 1–2; `Ctrl+D` copies the cell above; row
    selection via shift/ctrl-click on the row numbers; add and delete rows.
  - *Remove Duplicates…* reports a count before applying, and can be restricted
    to rows that also match on columns 1–2 and/or originate from the same PDF.
- **Export** — CSV with a UTF-8 BOM for correct degree-symbol rendering in Excel.
- **LLM Assist** (requires an API key) — Sends page text to an LLM to verify the
  extracted coordinates and to populate columns 1–2 from the surrounding text
  (e.g. species in column 1, colour in column 2; rename the headers and add
  prompt instructions to specify the desired output):
  - Providers: Anthropic (Claude), OpenAI, Google Gemini, DeepSeek, Qwen
    (Alibaba), Kimi (Moonshot), GLM (Zhipu), or any OpenAI-compatible endpoint.
    The API key is stored locally and sent only to the selected provider. A
    **Get an API key** link opens the provider's key page.
  - Per-provider model dropdown, plus a **Custom…** option for an arbitrary
    model ID.
  - Scope: pages with detected coordinates only, or full PDFs.
  - Concurrency: a bounded request pool of configurable size (`1` = sequential).
    Most effective with **one request per page**, which splits a PDF into many
    small independent requests; reduce it if a provider rate-limits.
  - Batch delay: an optional interval (ms) between batches. When set, a batch of
    the configured pool size is dispatched on a fixed interval regardless of
    whether the previous batch has completed. `0` (default) retains the
    steady-pool behaviour.
  - Per-row verdict badge: ✓ confirmed, ⚠ mismatch (click to apply the suggested
    correction), ? not found.
  - False-positive flagging: optionally flags rows that are not coordinates
    (dates, measurements, page numbers, etc.) with a 🗑 marker for one-by-one or
    bulk removal (*Delete Flagged*). An opt-in automatic-deletion mode removes
    flagged rows without confirmation; it resets each run and requires
    confirmation before starting.
  - LLM output is not authoritative. Verify all results against the source PDFs.
- **Update check** — Compares the running version against the latest GitHub
  release daily, and via a *Check for updates* button in the footer. Nothing is
  downloaded automatically.
- **Windows installer** — The `.exe` is an NSIS installer with a license page,
  install-location selection, desktop and start-menu shortcuts, and an
  uninstaller registered in *Apps & features*.

## Download

Builds are on the [Releases](../../releases) page:

| Platform | File |
| --- | --- |
| Windows | `CoordRippr-<version>-win-x64.exe` (NSIS installer) |
| macOS | `CoordRippr-<version>-mac-<arch>.dmg` |
| Ubuntu / Debian | `CoordRippr-<version>-linux-amd64.deb` |
| Fedora / RHEL | `CoordRippr-<version>-linux-x86_64.rpm` |
| Arch | `CoordRippr-<version>-linux-x64.pacman` |

The [GitHub Actions workflow](.github/workflows/build.yml) produces the builds.
Bumping the `version` in `package.json` and merging to `main` tags `v<version>`
and publishes a release with all installers attached (once per version). Pushing
a `v*` tag manually also works.

### Web version (GitHub Pages)

CoordRippr is plain JS and also runs entirely in the browser — no install, and
PDFs are processed locally in the page:
**https://calebhendren.github.io/CoordRippr/**

The [Pages workflow](.github/workflows/pages.yml) deploys on every push to
`main`. The first run requires GitHub Pages to be enabled; the workflow attempts
to enable it automatically, otherwise set *Settings → Pages → Source* to "GitHub
Actions". Browser-build caveats:

- Folder picking uses the File System Access API (Chrome/Edge only); other
  browsers fall back to a folder-upload prompt. Drag-and-drop works everywhere.
- LLM Assist calls the provider directly from the page, which some providers
  restrict via CORS. Anthropic, OpenAI, and Gemini work; some others may only
  work from the desktop app.

## Usage

1. **Open Folder…** (or *Open PDFs…*, or drag files in). Scanning starts
   immediately; the file list shows a hit count per PDF. Use a separate
   **project** per job to keep files, rows, and settings isolated; the last
   project is restored on the next launch.
2. Review the right panel: only pages with detections are shown, with hits
   highlighted. Hover a highlight to see the matched text. Adjust the **Net**
   slider to re-scan if the parser is too greedy or too conservative.
3. Fill columns 1–2 (site names, notes, etc.). For repeated values, use the
   *Fill* bar: select the column, a row range, and a value, then *Apply*.
4. Select the coordinate output format in the toolbar (DD / DMS / Both).
5. Correct any parser errors (edits are reformatted automatically) and delete
   false positives; the detection net is intentionally wide.
6. Optional: **LLM Assist…** — select a provider, enter an API key, specify the
   contents of columns 1–2, and run verification/fill. Review the results before
   relying on them.
7. **Export CSV…**

> Detection operates on the PDF text layer. Scanned or image-only PDFs contain no
> text to search; run OCR on them first.

## Development

```bash
npm install        # downloads Electron and pdf.js; requires network access
npm test           # parser / LLM / update unit tests + a pdf.js integration test
npm start          # run the app
npm run web        # build the static browser version into dist-web/
npm run dist       # package installers for the current platform
```

Key modules:

- `src/coords.js` — tokenizer, parser, formatter, intensity levels, and
  `extractCrossPage()`.
- `src/llm.js` — provider presets, request/response formats, prompt
  construction, work chunking, and the concurrency runners. Pure module, unit-
  tested.
- `src/persist.js` — IndexedDB-backed projects and session snapshots
  (`packState` / `unpackState` are pure and unit-tested).
- `src/pdftext.js` — pdf.js text items to a searchable string plus
  match-to-rectangle mapping.
- `tools/make-sample-pdf.mjs` — regenerates `test/fixtures/sample.pdf`, the
  two-column test document.
- `build/icon.svg` — icon source; rasterize with:
  ```bash
  npm i --no-save sharp
  node -e "require('sharp')('build/icon.svg').resize(1024,1024).png().toFile('build/icon.png')"
  ```

## License

MIT — see [LICENSE](LICENSE).
