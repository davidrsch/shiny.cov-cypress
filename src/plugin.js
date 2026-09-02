/**
 * shiny.cov-cypress — Cypress plugin
 *
 * Registers task handlers for interaction logging and UI manifest
 * persistence during Cypress end-to-end tests of Shiny applications. The
 * interaction log and the UI manifest (discovered from the browser's own
 * Shiny.inputBindings/Shiny.outputBindings registry by
 * cy.shinyCovDiscoverManifest() in support.js) are both written to
 * `.shiny.cov/` for `shiny.cov::collect()`/`shiny.cov::ui_report()` to
 * read on the R side.
 *
 * Usage in cypress.config.js:
 *
 *   const { defineConfig } = require('cypress')
 *   const shinyCovPlugin = require('shiny.cov-cypress/plugin')
 *
 *   module.exports = defineConfig({
 *     e2e: {
 *       setupNodeEvents(on, config) {
 *         shinyCovPlugin(on, config)
 *         return config
 *       }
 *     }
 *   })
 *
 * @module shiny.cov-cypress/plugin
 */

const fs = require('fs')
const path = require('path')

/**
 * Merge two UI manifest snapshots taken at different points in a test run.
 *
 * Mirrors shiny.cov's R-side merge_manifest_snapshots() (R/utils.R). Some
 * widget libraries strip their own distinguishing class once an input's
 * value changes (e.g. shinyWidgets::pickerInput()'s `.selectpicker` class
 * is present at initial render but gone after interaction), so a manifest
 * built only from the *last* snapshot can be less specific than one built
 * from an earlier point in the run -- merge instead of overwrite, and keep
 * whichever candidate type isn't a bare `shiny.*` base type.
 *
 * Only the human-readable `type` is affected; coverage/interaction
 * tracking is id-based and unaffected either way.
 *
 * @param {Object|null} oldManifest
 * @param {Object} newManifest
 * @returns {Object} Merged manifest.
 */
function mergeManifests(oldManifest, newManifest) {
  if (!oldManifest) return newManifest

  function isMoreSpecific(candidateType, currentType) {
    const currentIsBase = !currentType || currentType.indexOf('shiny.') === 0
    const candidateIsBase = !candidateType || candidateType.indexOf('shiny.') === 0
    return currentIsBase && !candidateIsBase
  }

  function mergeElements(oldEls, newEls) {
    const byId = {}
    ;(oldEls || []).forEach(el => { if (el && el.id) byId[el.id] = el })
    ;(newEls || []).forEach(el => {
      if (!el || !el.id) return
      const existing = byId[el.id]
      if (!existing) {
        byId[el.id] = el
        return
      }
      const merged = Object.assign({}, existing)
      if (isMoreSpecific(el.type, existing.type)) merged.type = el.type
      if (!merged.label && el.label) merged.label = el.label
      byId[el.id] = merged
    })
    return Object.keys(byId).map(k => byId[k])
  }

  function mergeArrays(a, b) {
    return Array.from(new Set([...(a || []), ...(b || [])]))
  }

  return {
    inputs: mergeElements(oldManifest.inputs, newManifest.inputs),
    outputs: mergeElements(oldManifest.outputs, newManifest.outputs),
    tabs: mergeArrays(oldManifest.tabs, newManifest.tabs),
    conditional: mergeArrays(oldManifest.conditional, newManifest.conditional),
    modules: mergeArrays(oldManifest.modules, newManifest.modules)
  }
}

module.exports = function shinyCovPlugin(on, config) {
  // Resolve output directory for interaction log
  const outputDir = config.env.shinyCovOutputDir ||
                    path.resolve(config.env.shinyCovAppDir || '.', '.shiny.cov')
  const interactionLogPath = path.join(outputDir, 'interactions.json')
  const manifestPath = path.join(outputDir, 'manifest.json')

  // In-memory interaction log (per-run, accumulates since the last flush)
  let interactionLog = []

  /**
   * Flush the in-memory interaction log to disk, merging with whatever is
   * already there rather than overwriting it.
   *
   * Mirrors shinyCovWriteManifest's read-merge-write pattern above --
   * necessary here for the same reason: this fires once per spec file (via
   * the shinyCovWriteLog task, typically from a spec's own after() hook)
   * as well as once globally in the after:run safety net, so a plain
   * overwrite would let only the last write survive and silently discard
   * every earlier spec's interactions in a multi-spec-file run.
   *
   * Clears the in-memory log after a successful write so that "write"
   * means "flush what's accumulated since the last flush" -- calling this
   * twice (once from a spec's own after() hook, once from after:run)
   * doesn't double-count entries that were already flushed.
   *
   * @returns {string|null} Path to the written file, or null on failure.
   */
  function flushLog() {
    try {
      fs.mkdirSync(outputDir, { recursive: true })
      let onDisk = []
      if (fs.existsSync(interactionLogPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(interactionLogPath, 'utf8'))
          onDisk = Array.isArray(parsed) ? parsed : []
        } catch (err) {
          console.error(
            'shiny.cov: failed to read/parse previous interactions.json for merging -- ' +
            'aborting this flush rather than overwriting a file we could not read ' +
            '(in-memory entries are kept for a retry):',
            err.message
          )
          return null
        }
      }
      const merged = onDisk.concat(interactionLog)
      fs.writeFileSync(interactionLogPath, JSON.stringify(merged, null, 2))
      console.log(`shiny.cov: wrote interaction log (${interactionLog.length} new, ${merged.length} total entries) to ${interactionLogPath}`)
      interactionLog = []
      return interactionLogPath
    } catch (err) {
      console.error('shiny.cov: failed to write interaction log:', err.message)
      return null
    }
  }

  on('task', {
    /**
     * Read the UI manifest that shiny.cov's R side writes to
     * `.shiny.cov/manifest.json`. There is no HTTP endpoint for this --
     * the manifest is a plain file in the same checkout Cypress runs
     * from, written before the app starts serving requests.
     *
     * @returns {Object|null} The manifest, or null if not found/unreadable.
     */
    shinyCovReadManifest() {
      if (!fs.existsSync(manifestPath)) {
        console.warn(`shiny.cov: manifest not found at ${manifestPath} ` +
          '(expected dir resolved from config.env.shinyCovAppDir / shinyCovOutputDir)')
        return null
      }
      try {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      } catch (err) {
        console.error('shiny.cov: failed to read/parse manifest.json:', err.message)
        return null
      }
    },

    /**
     * Write a UI manifest discovered by cy.shinyCovDiscoverManifest() to
     * `.shiny.cov/manifest.json` -- the same file shiny.cov::collect()
     * reads on the R side. Merges with whatever is already on disk (see
     * mergeManifests() above) rather than overwriting outright, since this
     * fires after every test via the global afterEach() in support.js.
     *
     * @param {Object} manifest
     * @returns {string|null} Path to the written file, or null on failure.
     */
    shinyCovWriteManifest(manifest) {
      try {
        fs.mkdirSync(outputDir, { recursive: true })
        let merged = manifest
        if (fs.existsSync(manifestPath)) {
          try {
            const previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
            merged = mergeManifests(previous, manifest)
          } catch (err) {
            console.error('shiny.cov: failed to read previous manifest.json for merging:', err.message)
          }
        }
        fs.writeFileSync(manifestPath, JSON.stringify(merged, null, 2))
        return manifestPath
      } catch (err) {
        console.error('shiny.cov: failed to write manifest.json:', err.message)
        return null
      }
    },

    /**
     * Store an interaction log entry.
     *
     * @param {Object} entry
     * @param {string} entry.selector - CSS selector for the element.
     * @param {string} entry.action - Action performed (click, type, select, etc.).
     * @param {*} [entry.value] - Optional value.
     * @param {number} [entry.timestamp] - Unix timestamp (defaults to now).
     */
    shinyCovLog(entry) {
      if (!entry || !entry.selector) return null
      interactionLog.push({
        selector: entry.selector,
        action: entry.action || 'unknown',
        value: entry.value !== undefined ? entry.value : null,
        timestamp: entry.timestamp || Date.now()
      })
      return null
    },

    /**
     * Retrieve the full interaction log as JSON.
     * @returns {Array} The interaction log entries.
     */
    shinyCovGetLog() {
      return interactionLog
    },

    /**
     * Clear the interaction log (called between spec files).
     */
    shinyCovClearLog() {
      interactionLog = []
      return null
    },

    /**
     * Get the number of logged interactions.
     * @returns {number}
     */
    shinyCovInteractionCount() {
      return interactionLog.length
    },

    /**
     * Flush the interaction log to disk, merging with any entries already
     * written by a previous spec in this run. Intended to be called from a
     * spec's own after()/afterEach() hook; also invoked as a safety net
     * from the after:run handler below in case a spec forgot to.
     * @returns {string} Path to the written file, or null on failure.
     */
    shinyCovWriteLog() {
      return flushLog()
    }
  })

  // Flush (not discard) anything still unflushed before the next spec
  // starts. By the time a spec's own after() hook has called
  // shinyCovWriteLog(), interactionLog is already empty and this is a
  // no-op. If it isn't -- a spec that forgot to flush -- warn, but still
  // flush it to disk ourselves so the entries survive; only the *last*
  // spec in a run would otherwise be caught by the after:run safety net,
  // silently losing every earlier spec's interactions that forgot to flush.
  on('before:spec', () => {
    if (interactionLog.length > 0) {
      console.warn(
        `shiny.cov: ${interactionLog.length} interaction(s) were logged but never flushed ` +
        'before the next spec started (call cy.task(\'shinyCovWriteLog\') at the end of the ' +
        'spec, e.g. in an after() hook) -- flushing them now so they are not lost'
      )
      flushLog()
    }
  })

  // Safety net: flush anything still unflushed at the end of the whole run
  // (e.g. a spec that never called shinyCovWriteLog itself).
  on('after:run', () => {
    if (interactionLog.length > 0) {
      flushLog()
    }
  })

  // Set default baseUrl if not configured. Use 127.0.0.1, not localhost:
  // shiny::runApp() binds IPv4 127.0.0.1 only, but Node 17+ resolves
  // "localhost" to the IPv6 loopback (::1) first -- the same mismatch
  // documented in server.js and the README's Quick Start baseUrl.
  if (!config.baseUrl) {
    config.baseUrl = 'http://127.0.0.1:3333'
  }

  return config
}

// Exposed for the R/JS merge-equivalence test (test/merge-manifest-equivalence.test.js) --
// shinyCovPlugin itself is still the module's callable default export.
module.exports.mergeManifests = mergeManifests
