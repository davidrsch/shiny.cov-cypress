const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { mergeManifests } = require('../src/plugin.js')

// Vendored from the R side's shiny.cov-r/tests/testthat/fixtures/manifest-merge-cases.json.
// Both languages assert against the same fixture's `expected` value rather
// than against each other's live output, so agreement doesn't need a
// runtime cross-language bridge. Vendoring the fixture (rather than reading
// it from a sibling path) keeps mergeManifests() under real test coverage
// in this package on its own, independent of repo layout.
const fixturePath = path.resolve(__dirname, 'fixtures', 'manifest-merge-cases.json')
const canonicalFixturePath = path.resolve(
  __dirname, '..', '..', 'shiny.cov-r', 'tests', 'testthat', 'fixtures', 'manifest-merge-cases.json'
)

// Element order within inputs/outputs is not semantically meaningful --
// Object.keys() iteration here treats integer-like string keys specially
// (ascending numeric, ahead of insertion order) in a way R's list-based
// merge doesn't, so the fixture's numeric-id case can produce a different
// but equally correct order. Sort before comparing.
function normalize(manifest) {
  const sortById = (els) => [...(els || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const sortStrings = (arr) => [...(arr || [])].sort()
  return {
    inputs: sortById(manifest.inputs),
    outputs: sortById(manifest.outputs),
    tabs: sortStrings(manifest.tabs),
    conditional: sortStrings(manifest.conditional),
    modules: sortStrings(manifest.modules)
  }
}

test('mergeManifests() matches the shared R/JS equivalence fixture', () => {
  const { cases } = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
  for (const c of cases) {
    const actual = mergeManifests(c.old, c.new)
    assert.deepStrictEqual(normalize(actual), normalize(c.expected), `case: ${c.name}`)
  }
})

// Guards against the vendored copy silently drifting from the R package's
// canonical copy. Only meaningful for maintainers who have both packages
// checked out side by side, so it skips itself otherwise rather than
// requiring that layout.
test('vendored manifest-merge-cases.json matches the canonical R-package copy', (t) => {
  if (!fs.existsSync(canonicalFixturePath)) {
    t.skip('sibling shiny.cov-r/ package not present -- this check only runs meaningfully when developing with the monorepo layout available; not required for this package\'s own CI.')
    return
  }
  const vendored = fs.readFileSync(fixturePath, 'utf8')
  const canonical = fs.readFileSync(canonicalFixturePath, 'utf8')
  assert.strictEqual(
    vendored,
    canonical,
    'test/fixtures/manifest-merge-cases.json is out of sync with shiny.cov-r/tests/testthat/fixtures/manifest-merge-cases.json -- copy the canonical file over the vendored one and commit the result.'
  )
})
