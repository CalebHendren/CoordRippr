# CoordRippr 🌐⚔️

**Rip coordinate data out of PDFs.** Point CoordRippr at a folder of PDFs (journal
articles, reports, field notes — two-column layouts welcome) and it scans every
page for anything that remotely resembles a latitude/longitude, highlights the
hits on the page, and builds a clean, editable CSV.

## Features

- **Batch scanning** — open a folder and every PDF in it (recursively) is scanned.
  Individual file picking and drag & drop work too.
- **Extremely wide detection net** — DD (`41.40338, 2.17403`) and DMS
  (`41°24'12.2"N`) in all their degenerate forms:
  - `o` or `O` standing in for the degree symbol (`12o30'N`)
  - any tick mark for minutes/seconds: `'` `′` `’` `` ` `` `´`, `"` `″` `”`, doubled ticks
  - hemisphere as letters (`N`, `s`) or words (`South`, `West`), leading or trailing
  - `Lat.` / `Long.` labels, space-separated DMS (`40 26 46 N`), decimal commas
  - coordinates broken across **line breaks**
- **Focused page view** — only pages containing detections are shown
  (toggle *Show all pages* to see everything). Every hit is highlighted.
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
- **CSV export** with UTF-8 BOM (Excel-safe degree symbols).

## Download

Grab the latest build from the [Releases](../../releases) page:

| Platform | File |
| --- | --- |
| Windows | `CoordRippr-<version>-win-x64.exe` (NSIS installer) |
| macOS | `CoordRippr-<version>-mac-<arch>.dmg` |
| Ubuntu / Debian | `CoordRippr-<version>-linux-amd64.deb` |
| Fedora / RHEL | `CoordRippr-<version>-linux-x86_64.rpm` |
| Arch | `CoordRippr-<version>-linux-x64.pacman` |

Builds are produced by the [GitHub Actions workflow](.github/workflows/build.yml);
pushing a `v*` tag creates a release with all installers attached.

## Usage

1. **Open Folder…** (or *Open PDFs…* / drag files in). Scanning starts
   immediately; the file list shows a hit count per PDF.
2. Review the right panel: only pages with detections are shown, hits are
   highlighted yellow. Hover a highlight to see the raw matched text.
3. Fill in columns 1–2 (site names, notes, …). For repeated values use the
   *Fill* bar: pick the column, a row range, a value → *Apply*.
4. Pick the coordinate output format in the toolbar (DD / DMS / Both).
5. Fix anything the parser got wrong — edits are auto-cleaned — and delete
   false positives (the net is wide on purpose).
6. **Export CSV…**

> **Note:** detection works on the PDF *text layer*. Scanned/image-only PDFs
> have no text to search — run OCR on them first.

## Development

```bash
npm install        # needs network access to download Electron
npm test           # parser unit tests + pdf.js integration test
npm start          # run the app
npm run dist       # package for the current platform
```

Useful bits:

- `src/coords.js` — the tokenizer/parser/formatter. Start here to widen the net further.
- `src/pdftext.js` — pdf.js text items → searchable string + match-to-rectangle mapping.
- `tools/make-sample-pdf.mjs` — regenerates `test/fixtures/sample.pdf` (the messy two-column test document).
- `build/icon.svg` — icon source; rasterize with:
  ```bash
  npm i --no-save sharp
  node -e "require('sharp')('build/icon.svg').resize(1024,1024).png().toFile('build/icon.png')"
  ```

## License

MIT — see [LICENSE](LICENSE).
