# shiny.cov-cypress

Cypress adapter for [the shiny.cov R package](https://github.com/davidrsch/shiny.cov-r) -- UI and server coverage for Shiny apps tested with Cypress.

## Installation

```bash
npm install --save-dev shiny.cov-cypress
```

If you're developing this package itself from a local checkout, install it as a real `file:`-protocol dependency (`npm install` creates a `node_modules/shiny.cov-cypress` symlink, so edits stay live) rather than `require()`ing it via a raw relative path reaching outside `node_modules` -- Cypress's support/spec bundler can serve a persistently stale bundle for files loaded that way:

```json
{
  "devDependencies": {
    "shiny.cov-cypress": "file:../path/to/shiny.cov-cypress"
  }
}
```

## Quick start

### 1. Configure Cypress

```js
// cypress.config.js
const { defineConfig } = require('cypress')
const shinyCovPlugin = require('shiny.cov-cypress/plugin')

module.exports = defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      shinyCovPlugin(on, config)
      return config
    },
    // 127.0.0.1, not localhost: shiny::runApp() binds IPv4 127.0.0.1
    // only, and Node 17+ resolves "localhost" to the IPv6 loopback (::1)
    // first by default -- on a machine where that doesn't fall back to
    // IPv4 quickly, wait-on/start-server-and-test times out against a
    // server that's genuinely up (the R side logs
    // "Listening on http://127.0.0.1:3333" while start-server-and-test
    // still times out against "localhost").
    baseUrl: 'http://127.0.0.1:3333',
    env: {
      // Resolves where the plugin reads/writes .shiny.cov/*.json -- must
      // match the app_dir setup()/collect() use below. Without this, the
      // plugin resolves .shiny.cov/ against Cypress's own working
      // directory instead of "app/", so shiny.cov::collect("app") never
      // finds the manifest/interactions the plugin wrote -- UI coverage
      // silently reports as empty, with no error.
      shinyCovAppDir: 'app'
    }
  }
})
```

### 2. Load support commands

```js
// cypress/support/e2e.js
require('shiny.cov-cypress/support')
```

### 3. Run tests with coverage

`shiny.cov::setup()` must run *before* the app starts, from a separate step -- it's what actually writes the `app.R` wrapper and `.Rprofile` bootstrap that make the `SHINYCOV_OUTPUT` environment variable below do anything at all. Skipping this step is an easy mistake, since nothing errors when you do: the app just silently runs uninstrumented and produces an empty coverage file. (`R_COVR` is kept only for compatibility with older shiny.cov releases; the current instrumentation reads `SHINYCOV_OUTPUT` and ignores it.) Use [`start-server-and-test`](https://www.npmjs.com/package/start-server-and-test) (add it as your own devDependency) with [`cross-env`](https://www.npmjs.com/package/cross-env) to set the environment variables portably across shells.

```r
# setup-coverage.R
shiny.cov::setup("app")
```

```r
# run-app.R
shiny::runApp("app", port = 3333, host = "127.0.0.1")
```

```json
// package.json scripts
{
  "setup-coverage": "Rscript setup-coverage.R",
  "run-app-coverage": "npm run setup-coverage && cross-env SHINYCOV_OUTPUT=app/.shiny.cov/coverage.rds R_COVR=true SHINYCOV_SOURCE=cypress Rscript run-app.R",
  "cypress:run": "cypress run",
  "test-e2e-coverage": "start-server-and-test run-app-coverage http://127.0.0.1:3333 cypress:run",
  "posttest-e2e-coverage": "Rscript collect-coverage.R"
}
```

```r
# collect-coverage.R
cov <- shiny.cov::collect("app")
covr::report(cov)
shiny.cov::cleanup("app")
```

```bash
npm run test-e2e-coverage
```

(Using real `.R` script files instead of inline `Rscript -e "..."` avoids shell-specific quoting issues across `cmd.exe`/PowerShell/bash.)

If a run fails partway through (server timeout, a failing test, `Ctrl+C`), `app.R` is left wrapped and the next `setup()` call will refuse to run until you clean it up. Add a `pretest-e2e-coverage` npm hook (npm runs this automatically before `test-e2e-coverage`, matched by name) so every run starts from a clean slate regardless of how the previous one ended:

```json
{
  "scripts": {
    "cleanup-coverage": "Rscript -e \"shiny.cov::cleanup('app')\"",
    "pretest-e2e-coverage": "npm run cleanup-coverage"
  }
}
```

### 4. Log interactions

Right after each real Cypress command, log it explicitly:

```js
cy.get('#name').type('Alice')
cy.shinyCovInteract('#name', 'type', 'Alice')
```

Use one of the recognized action names so it's actually counted. The verbs this adapter naturally emits are `click`, `type`, `select`, `check`, `uncheck` for inputs and `get_text`/`get_html` for outputs; shiny.cov's shared vocabulary also counts the shinytest2 verbs `set_inputs`, `upload_file`, and `get_value` for inputs, so those work too.

## Features

- Discovers the UI manifest by asking the live browser's own `Shiny.inputBindings`/`Shiny.outputBindings` registry what's actually bound, via `cy.shinyCovDiscoverManifest()`, called automatically after every test. This runs the literal same script the R/shinytest2 side does (`shiny.cov-r/inst/js/discover-bindings.js`, vendored in via `scripts/sync-discover-bindings.js`), evaluated in the app's own `window` via `win.eval()`, and works for any widget library, not just base Shiny, since every real Shiny input/output must register there regardless of who built it. One caveat of evaluating it this way: `win.eval()` is subject to the app's Content-Security-Policy, unlike shinytest2's CDP-based evaluation, which bypasses page CSP -- only relevant if you've opted into Cypress's `experimentalCspAllowList: true` with a strict `script-src` (Cypress strips CSP by default, so this is a rare edge case).
- `cy.shinyCovManifest()` reads back whatever was last discovered, from `.shiny.cov/manifest.json` -- no HTTP endpoint involved either way.
- Explicit interaction logging via `cy.shinyCovInteract()` -- no automatic logging via overridden `cy.click()`/`cy.type()`/etc. commands: chaining a `cy.task()` call into an overridden actionability command is unreliable in a real Cypress browser run.
- Exports interaction data for the combined coverage report.
- No dependencies of its own beyond `cypress` (a peer dependency) -- bring your own `start-server-and-test`/`cross-env` for orchestrating the server + test run, same as any other Cypress project would.
- A bundled `server.js` (`require('shiny.cov-cypress/server')`) offers the same launch as a single Node call: it sets `SHINYCOV_SERVER_APP_DIR`/`SHINYCOV_SERVER_PORT`/`SHINYCOV_OUTPUT`/`R_COVR` and spawns `Rscript -e "shiny.cov:::run_covr_server()"`, forwarding SIGTERM/SIGINT so `coverage.rds` is written on shutdown. The quick start above uses `Rscript run-app.R` + `cross-env` instead so it needs no custom Node entry point; both start the same instrumented app.

## License

MIT © David Díaz
