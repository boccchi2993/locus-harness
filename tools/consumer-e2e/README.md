# Tarball consumer harness (sources)

These files are the SOURCE of the out-of-checkout tarball consumer used by
CI (`out-of-checkout tarball consumer` job): CI copies them under
`RUNNER_TEMP`, installs the packed `locus-harness` tarball there, builds the
page with the consumer's own Vite from the public entry import only
(`import … from 'locus-harness'`), and drives acceptance gates A–J in
headless Chrome over the built artifact.

The consumer instance NEVER runs inside this checkout — that isolation is
the point of the gate (it proves the package is self-contained: no
adjacency, no `file:` dependency, no checkout `src/` fallback). The primary
local verification was performed with this harness assembled in a directory
outside the checkout; see docs/EXTRACTION-PLAN.md §7.

- `consumer-main.js` — the page script (public entry import only; gates A–J)
- `index.html` / `vite.config.js` / `package.json` — the consumer's own build
- `e2e-consumer.cjs` — the CDP gate driver (uses the repo's
  `tests/helpers/chrome.cjs`, copied next to it at assembly time)
