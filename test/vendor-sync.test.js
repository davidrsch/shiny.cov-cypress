/**
 * Confirms src/vendor/discover-bindings-source.js still matches the
 * canonical R-package source it's generated from. This needs the sibling
 * shiny.cov-r/ package present on disk, which is only true for maintainers
 * who check out both packages side by side; it skips itself otherwise.
 * `test/` isn't part of the published npm package per package.json's
 * `files` field, so this never runs in a downstream consumer's environment.
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')

const { CANONICAL_PATH, OUTPUT_PATH, renderVendoredModule } = require('../scripts/sync-discover-bindings.js')

test('vendored discover-bindings-source.js is in sync with the canonical R-package source', (t) => {
  if (!fs.existsSync(CANONICAL_PATH)) {
    t.skip('sibling shiny.cov-r/ package not present -- this check only runs meaningfully when developing with the monorepo layout available; not required for this package\'s own CI.')
    return
  }
  const canonicalSource = fs.readFileSync(CANONICAL_PATH, 'utf8')
  const expected = renderVendoredModule(canonicalSource)
  const actual = fs.readFileSync(OUTPUT_PATH, 'utf8')

  assert.strictEqual(
    actual,
    expected,
    'vendored discover-bindings.js is out of sync with the canonical R-package source -- run `node scripts/sync-discover-bindings.js` from shiny.cov-cypress/ and commit the result.'
  )
})
