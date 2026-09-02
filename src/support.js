/**
 * shiny.cov-cypress — Cypress support commands
 *
 * Provides custom Cypress commands for fetching the Shiny UI manifest
 * and logging DOM interactions during tests.
 *
 * Import in cypress/support/e2e.js:
 *
 *   require('shiny.cov-cypress/support')
 *
 * @module shiny.cov-cypress/support
 */

const discoverBindingsSource = require('./vendor/discover-bindings-source.js')

// ---- Commands ----

/**
 * Fetch the UI manifest written by the R side to `.shiny.cov/manifest.json`.
 *
 * shiny.cov's R process builds the manifest and writes it to disk in the
 * same checkout Cypress runs from -- there's no need to serve it over HTTP
 * (and shiny.cov never actually implemented a `/__shiny.cov/manifest`
 * route), so this reads the file directly via a Cypress task.
 *
 * @returns {Cypress.Chainable<Object>} The manifest JSON.
 *
 * @example
 * cy.shinyCovManifest().then(manifest => {
 *   cy.log(`Found ${manifest.inputs.length} inputs`)
 * })
 */
Cypress.Commands.add('shinyCovManifest', () => {
  return cy.task('shinyCovReadManifest').then(manifest => {
    if (manifest) {
      return manifest
    }
    cy.log('shiny.cov: manifest.json not found -- has shiny.cov::setup() run yet?')
    return { inputs: [], outputs: [], tabs: [], conditional: [], modules: [] }
  })
})

/**
 * Discover the live UI manifest by asking the app's own
 * Shiny.inputBindings/Shiny.outputBindings registry what's actually bound
 * on the page, and write it to `.shiny.cov/manifest.json`.
 *
 * This is the Cypress-side counterpart to shiny.cov's R side reading the
 * same registry via AppDriver$get_js() -- see
 * shiny.cov-r/inst/js/discover-bindings.js, which this mirrors. Discovering
 * from the actual live registry (rather than guessing from CSS classes)
 * means this works for any widget library, not just base Shiny -- anything
 * that registers a real Shiny input/output binding is found automatically.
 *
 * Called automatically after each test (see the global afterEach() below);
 * call it explicitly mid-test if you want a fresh snapshot sooner.
 *
 * @returns {Cypress.Chainable<Object>} The discovered manifest.
 */
Cypress.Commands.add('shinyCovDiscoverManifest', () => {
  return cy.window({ log: false }).then(win => {
    const manifest = shinyCovDiscoverFromWindow(win)
    return cy.task('shinyCovWriteManifest', manifest, { log: false }).then(() => manifest)
  })
})

/**
 * Runs shiny.cov-r/inst/js/discover-bindings.js (vendored into
 * src/vendor/discover-bindings-source.js -- see
 * scripts/sync-discover-bindings.js) against a given window.
 *
 * The vendored script's IIFE references bare `window`/`document`/`CSS`
 * globals, not `win.`-qualified ones, since it's shared verbatim with the
 * R side, which evaluates it in a real page context where those globals
 * are already correct. `win.eval()` is indirect eval, which per spec runs
 * in the global scope of the object it's called on -- so calling it on
 * Cypress's app-iframe `win` makes those bare names resolve to that
 * iframe's own `window`/`document`/`CSS`, not the top-level test runner's.
 */
function shinyCovDiscoverFromWindow(win) {
  return win.eval(discoverBindingsSource)
}

// Automatically snapshot the UI manifest after each test, so users don't
// have to remember to call cy.shinyCovDiscoverManifest() themselves.
// `afterEach` is a Mocha global Cypress provides at real test-run time;
// guard it so this file can still be require()d in other contexts (e.g.
// this package's own plain-Node unit tests) without throwing.
if (typeof afterEach === 'function') {
  afterEach(() => {
    cy.shinyCovDiscoverManifest()
  })
}

// Exported for this package's own unit tests (test/support.test.js) --
// not part of the public API consumers should rely on.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { shinyCovDiscoverFromWindow }
}

// ---- Auto-log overrides: not implemented ----
//
// Overwriting cy.click()/cy.type()/cy.select()/cy.check()/cy.uncheck() to
// auto-log via a chained cy.task() reliably breaks Cypress's own
// promise/command-queue handling in a real browser, regardless of whether
// the task call is chained before or after the original command (see
// cypress-io/cypress#3166, #17350, #19597). Log explicitly instead, via
// cy.shinyCovInteract(selector, action, value) immediately after the real
// Cypress command -- see vignette("cypress", package = "shiny.cov").

/**
 * Log a Shiny input interaction for coverage tracking.
 *
 * Records that a specific input element was interacted with during the test.
 * The data is stored in the Cypress task log and can be written to disk
 * after the test run via cy.task('shinyCovWriteLog').
 *
 * @param {string} selector - CSS selector for the element.
 * @param {string} action - Action performed (click, type, select, etc.).
 * @param {*} [value] - Optional value.
 *
 * @example
 * cy.get('#name').type('Alice')
 * cy.shinyCovInteract('#name', 'type', 'Alice')
 */
Cypress.Commands.add('shinyCovInteract', (selector, action, value) => {
  return cy.task('shinyCovLog', {
    selector,
    action,
    value: value !== undefined ? value : null,
    timestamp: Date.now()
  })
})
