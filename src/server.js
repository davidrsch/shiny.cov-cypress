/**
 * shiny.cov-cypress — Server launcher
 *
 * Starts a Shiny app with coverage environment variables set so that
 * the shiny.cov bootstrap activates instrumentation. The actual R entry
 * point is shiny.cov:::run_covr_server() (shiny.cov-r/R/server.R), shared
 * with the Playwright adapter; this module is just the Node-side
 * spawn/readiness/signal-forwarding wrapper around it.
 *
 * Designed to work with `start-server-and-test`:
 *
 *   "scripts": {
 *     "start-shiny": "node src/server.js",
 *     "test-e2e": "cypress run",
 *     "test-e2e-coverage": "start-server-and-test start-shiny http://127.0.0.1:3333 test-e2e"
 *   }
 *
 * @module shiny.cov-cypress/server
 */

const { spawn } = require('child_process')
const path = require('path')
const http = require('http')

/**
 * Start a Shiny app with shiny.cov coverage instrumentation enabled.
 *
 * Sets SHINYCOV_SERVER_APP_DIR/SHINYCOV_SERVER_PORT (read back inside R
 * by shiny.cov:::run_covr_server()) and SHINYCOV_OUTPUT/R_COVR, then
 * spawns the R process. The app wrapper + .Rprofile bootstrap written by
 * shiny.cov::setup() detect SHINYCOV_OUTPUT and load the bootstrap
 * instrumentation.
 *
 * @param {Object} options
 * @param {number} [options.port=3333] - Port for the Shiny app.
 * @param {string} [options.appDir='.'] - Path to the Shiny app directory.
 * @param {string} [options.outputDir='.shiny.cov'] - Path for coverage output.
 * @param {boolean} [options.wait=true] - Wait for the server to be ready before resolving.
 * @param {number} [options.timeout=30000] - Max wait time in ms for server to be ready.
 * @returns {Promise<ChildProcess>} Resolves when the server is ready (or immediately if wait=false).
 */
function startShinyWithCoverage(options = {}) {
  const {
    port = 3333,
    appDir = '.',
    outputDir = '.shiny.cov',
    wait = true,
    timeout = 30000
  } = options

  const appDirAbs = path.resolve(appDir)
  const coverageRds = path.resolve(appDirAbs, outputDir, 'coverage.rds')

  const env = {
    ...process.env,
    SHINYCOV_OUTPUT: coverageRds,
    R_COVR: 'true',
    SHINYCOV_SOURCE: 'cypress',
    SHINYCOV_SERVER_APP_DIR: appDirAbs,
    SHINYCOV_SERVER_PORT: String(port)
  }

  // Deliberately a static literal with nothing interpolated at all --
  // appDir/port are passed through env (above) and read back inside R by
  // shiny.cov:::run_covr_server() (shiny.cov-r/R/server.R), the same
  // helper the Playwright adapter's webServer.command invokes, so the two
  // adapters share one copy of the env-var parsing and IPv4-loopback
  // binding logic (see the readiness poll below for why that binding
  // matters). Keeping this string interpolation-free means a value
  // containing `"`/backslash sequences can never break out of an R string
  // literal and inject arbitrary R.
  const rCommand = 'shiny.cov:::run_covr_server()'

  console.log(`shiny.cov: starting Shiny app from ${appDirAbs} on port ${port}`)
  console.log(`shiny.cov: coverage output → ${coverageRds}`)

  const child = spawn('Rscript', ['-e', rCommand], {
    env,
    cwd: appDirAbs,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  child.stdout.on('data', (data) => {
    process.stdout.write(`[shiny] ${data}`)
  })

  child.stderr.on('data', (data) => {
    process.stderr.write(`[shiny:err] ${data}`)
  })

  child.on('error', (err) => {
    console.error('shiny.cov: failed to start Shiny process:', err.message)
    process.exit(1)
  })

  // Tracks whether the child has actually exited, as distinct from
  // child.killed (which Node sets synchronously the moment kill()
  // successfully *sends* a signal, not when the process actually exits --
  // see the SIGTERM handler below).
  let childExited = false

  child.on('exit', (code, signal) => {
    childExited = true
    if (signal) {
      console.log(`shiny.cov: Shiny process killed by ${signal}`)
    } else {
      console.log(`shiny.cov: Shiny process exited with code ${code}`)
    }
  })

  // Forward SIGTERM/SIGINT to the child so coverage.rds gets written
  process.on('SIGTERM', () => {
    console.log('shiny.cov: forwarding SIGTERM to Shiny process')
    child.kill('SIGTERM')
    // Give the Shiny process time to write coverage.rds via onStop().
    // child.killed would be true here almost immediately regardless of
    // whether the process actually died (it just reflects that the signal
    // was sent), so the force-kill escalation must check actual exit
    // (childExited, set from the 'exit' event above) instead -- otherwise
    // this fallback effectively never fires.
    setTimeout(() => {
      if (!childExited) {
        console.log('shiny.cov: forcing Shiny shutdown')
        child.kill('SIGKILL')
      }
    }, 5000)
  })

  process.on('SIGINT', () => {
    console.log('shiny.cov: forwarding SIGINT to Shiny process')
    child.kill('SIGINT')
    // Same escalation as the SIGTERM handler above: give the Shiny process
    // time to write coverage.rds via onStop(), then force-kill if it still
    // hasn't actually exited (childExited, not child.killed).
    setTimeout(() => {
      if (!childExited) {
        console.log('shiny.cov: forcing Shiny shutdown')
        child.kill('SIGKILL')
      }
    }, 5000)
  })

  if (!wait) {
    return Promise.resolve(child)
  }

  // Wait for the server to be ready
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const timer = setInterval(() => {
      // 127.0.0.1, not localhost: Node 17+ resolves `localhost` to the IPv6
      // loopback by default, but shiny::runApp() above binds only the IPv4
      // loopback (host = "127.0.0.1") -- this poll must target the same
      // address or it hangs against a server that never answers on ::1.
      http.get(`http://127.0.0.1:${port}`, (res) => {
        clearInterval(timer)
        console.log(`shiny.cov: Shiny server ready on port ${port}`)
        resolve(child)
      }).on('error', () => {
        if (Date.now() - start > timeout) {
          clearInterval(timer)
          reject(new Error(`Timed out waiting for Shiny on port ${port}`))
        }
      })
    }, 500)
  })
}

// Export for programmatic use
module.exports = { startShinyWithCoverage }

// When executed directly, start the server
if (require.main === module) {
  const port = parseInt(process.env.SHINYCOV_PORT || process.env.PORT || '3333', 10)
  const appDir = process.env.SHINYCOV_APP_DIR || process.cwd()

  startShinyWithCoverage({ port, appDir, wait: true })
    .then(() => {
      console.log('shiny.cov: server is running. Press Ctrl+C to stop.')
    })
    .catch((err) => {
      console.error('shiny.cov:', err.message)
      process.exit(1)
    })
}
