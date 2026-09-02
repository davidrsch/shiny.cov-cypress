# shiny.cov

Monorepo for the shiny.cov project — real end-to-end coverage (server lines + browser-verified UI interaction, blended into one number) for Shiny apps, in R or Python.

## Packages

**Two independent cores, one per language — they don't depend on each other, and share nothing beyond the `shiny.cov` name and a vendored copy of the same browser-side UI-discovery script.** Each core can drive multiple UI-testing frameworks; some frameworks are supported natively, others need a companion adapter package installed alongside the core (see each row below). This isn't a closed list — more frameworks can be added to either core over time without changing this structure.

### R Shiny

| Package | Language | Purpose |
|---|---|---|
| [shiny.cov](./shiny.cov-r/) | R | Core instrumentation, coverage collection, reporting. shinytest2 support is built in; Cypress/Playwright support requires the companion adapters below. |
| [shiny.cov-cypress](./shiny.cov-cypress/) | JavaScript | Cypress adapter for the shiny.cov R package — required alongside it for Cypress-driven tests, not usable standalone. |
| [shiny.cov-playwright](./shiny.cov-playwright/) | JavaScript | Playwright adapter for the shiny.cov R package — required alongside it for Playwright-driven tests, not usable standalone. |

### Python Shiny (py-shiny)

| Package | Language | Purpose |
|---|---|---|
| [shiny.cov](./shiny.cov-py/) | Python | pytest plugin for py-shiny apps — server + UI coverage blended into one number. Playwright support is built in (no separate adapter exists or is needed); fully independent of the R package above and of `shiny.cov-playwright` (a different package, for R apps only, despite the name overlap). |

## Examples

| Directory | Purpose |
|---|---|
| [examples/shinytest2](./examples/shinytest2/) | Plain `app.R` driven by shinytest2 |
| [examples/cypress](./examples/cypress/) | Plain `app.R` driven by Cypress |
| [rhinoApp](./rhinoApp/) | Real `{box}`/rhino app, driven by shinytest2 (`run_shinycov_e2e.R`) |
| [rhino-cypress-e2e](./rhino-cypress-e2e/) | The same rhino app, driven by a real Cypress browser instead |
| [shiny.cov-py/examples/minimal_app](./shiny.cov-py/examples/minimal_app/) | Plain py-shiny app driven by `shiny.cov` (Python) + Playwright |

## Design

See [`shiny.cov-design.md`](./shiny.cov-design.md) for the original architectural design and rationale (predates the
project's rename to shiny.cov — package/directory names in that document are stale). Note that the implementation has
since diverged from that document in several places (see its "Implementation notes" addendum) — the `shiny.cov` (R)
package README is the accurate reference for current behavior.

## License

MIT © David Díaz
