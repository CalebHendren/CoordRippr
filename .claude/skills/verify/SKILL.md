# Verifying CoordRippr changes end-to-end

CoordRippr is an Electron app with an equivalent browser build. The easiest
runtime surface in a headless environment is the web build driven by
Playwright + Chromium.

## Build & serve

```bash
npm install --no-save --ignore-scripts pdfjs-dist@<version-from-package.json> playwright
node tools/build-web.mjs          # emits dist-web/
# serve dist-web with any static file server on localhost
```

## Drive with Playwright

- Launch with `executablePath: '/opt/pw-browsers/chromium'` (pre-installed;
  never run `playwright install`).
- Load a PDF by dispatching a synthetic `drop` event on `document` with a
  `DataTransfer` holding a `File` built from `test/fixtures/sample.pdf`
  (5 coordinate pairs on page 1). The file pickers need user gestures and
  can't be automated.
- Wait for `#status` to read `… N rows` and lose the `busy` class.

## Mocking the LLM assist

`src/webshim.js` `netFetch` rejects non-https URLs, so a local http mock does
NOT work. Instead intercept a fake https origin with `page.route`:

- Set provider to `custom` (no API key needed), URL `https://mock.test/chat`.
- The route handler parses `messages.at(-1).content`, extracts row ids with
  `/^(r\d+) \|/gm`, and fulfills with the OpenAI shape:
  `{choices:[{message:{content: JSON.stringify([{row, verdict:'ok', …}])}}]}`.
- `page.route` survives `page.reload()`, which is how to test persistence
  (state lives in IndexedDB `coordrippr`; prefs in localStorage).

## Gotchas

- The LLM dialog is `#llm-dialog`; status text lands in `#llm-status`;
  run/stop button is `#llm-run`.
- Wipe state between scenarios with `localStorage.clear()` +
  `indexedDB.deleteDatabase('coordrippr')`, then reload.
- The debounced snapshot write is 600 ms — wait ~1 s before reloading if the
  scenario depends on persisted state.
