/**
 * Tests for src/server.js. This file is currently dead code (neither real
 * integration invokes it -- both rhino-cypress-e2e/package.json and
 * examples/cypress/package.json call `Rscript start-app.R` directly) but it
 * ships as part of the package's public source, so it's held to the same
 * bar as anything else here.
 *
 * We never actually spawn Rscript or make a real HTTP request. Following
 * the mocking style already established in support.test.js (assign fake
 * globals/module properties before requiring the module under test, then
 * exercise the real exported functions against those fakes) we monkeypatch
 * `child_process.spawn` and `http.get` directly on the (shared, cached)
 * module objects returned by require('child_process')/require('http').
 * Because src/server.js destructures `spawn` out of child_process at
 * *require* time, the patch has to be in place -- and the require cache for
 * server.js cleared -- before each (re-)require.
 */
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { EventEmitter } = require('node:events')

function makeFakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.lastKillSignal = null
  child.kill = (signal) => {
    // Real child_process semantics: killed flips to true synchronously the
    // moment the signal is *sent*, regardless of whether the process has
    // actually exited yet. Tests decide separately (by emitting 'exit')
    // whether/when the process actually dies.
    child.killed = true
    child.lastKillSignal = signal
  }
  return child
}

function loadServerWithMockedSpawn(spawnImpl) {
  const cp = require('child_process')
  const originalSpawn = cp.spawn
  cp.spawn = spawnImpl
  delete require.cache[require.resolve('../src/server.js')]
  const mod = require('../src/server.js')
  return {
    mod,
    restore() {
      cp.spawn = originalSpawn
      delete require.cache[require.resolve('../src/server.js')]
    }
  }
}

test.afterEach(() => {
  // startShinyWithCoverage() registers new SIGTERM/SIGINT listeners on the
  // real process object every call; strip them between tests so one test's
  // listener can't fire (or accumulate MaxListenersExceededWarning) during
  // another's process.emit().
  process.removeAllListeners('SIGTERM')
  process.removeAllListeners('SIGINT')
})

test('spawns Rscript with a static -e command, threading appDir/port through env instead of interpolation', () => {
  const calls = []
  const fakeChild = makeFakeChild()
  const { mod, restore } = loadServerWithMockedSpawn((command, args, opts) => {
    calls.push({ command, args, opts })
    return fakeChild
  })
  try {
    // A path engineered to break out of an R string literal if it were
    // ever interpolated directly into the `Rscript -e` source.
    const maliciousAppDir = '/tmp/app"); system("touch /tmp/pwned'
    mod.startShinyWithCoverage({ appDir: maliciousAppDir, port: 4444, wait: false })

    assert.strictEqual(calls.length, 1)
    const { command, args, opts } = calls[0]
    assert.strictEqual(command, 'Rscript')
    assert.strictEqual(args[0], '-e')

    const rCommand = args[1]
    // Never contains the raw appDir value or the port, in any form.
    assert.ok(!rCommand.includes(maliciousAppDir))
    assert.ok(!rCommand.includes(path.resolve(maliciousAppDir)))
    assert.ok(!rCommand.includes('4444'))
    // Delegates to the shared R entry point; env-var parsing and the
    // IPv4-loopback binding now live inside shiny.cov:::run_covr_server()
    // (shiny.cov-r/R/server.R, tested by the R package's test-server.R) --
    // this module no longer hand-builds a shiny::runApp() string that a
    // malicious appDir/port could be interpolated into.
    assert.strictEqual(rCommand, 'shiny.cov:::run_covr_server()')

    // The actual values are passed via env instead.
    assert.strictEqual(opts.env.SHINYCOV_SERVER_APP_DIR, path.resolve(maliciousAppDir))
    assert.strictEqual(opts.env.SHINYCOV_SERVER_PORT, '4444')
  } finally {
    restore()
  }
})

test('the -e command string is identical across calls regardless of appDir/port (proves it is a static literal, not built per-call)', () => {
  const capturedCommands = []
  const fakeChild1 = makeFakeChild()
  const fakeChild2 = makeFakeChild()
  let call = 0
  const { mod, restore } = loadServerWithMockedSpawn((command, args) => {
    capturedCommands.push(args[1])
    call += 1
    return call === 1 ? fakeChild1 : fakeChild2
  })
  try {
    mod.startShinyWithCoverage({ appDir: '/one/app', port: 1111, wait: false })
    mod.startShinyWithCoverage({ appDir: '/somewhere/else', port: 9999, wait: false })

    assert.strictEqual(capturedCommands.length, 2)
    assert.strictEqual(capturedCommands[0], capturedCommands[1])
  } finally {
    restore()
  }
})

test('readiness poll requests 127.0.0.1, not localhost', async () => {
  const http = require('http')
  const originalGet = http.get
  const requestedUrls = []
  http.get = (url, cb) => {
    requestedUrls.push(url)
    process.nextTick(() => cb({}))
    return new EventEmitter()
  }
  const fakeChild = makeFakeChild()
  const { mod, restore } = loadServerWithMockedSpawn(() => fakeChild)
  try {
    await mod.startShinyWithCoverage({ port: 5555, wait: true })

    assert.ok(requestedUrls.length > 0)
    for (const url of requestedUrls) {
      assert.ok(url.startsWith('http://127.0.0.1:5555'), `expected ${url} to target 127.0.0.1`)
      assert.ok(!url.includes('localhost'), `expected ${url} not to use localhost`)
    }
  } finally {
    http.get = originalGet
    restore()
  }
})

test('SIGKILL fallback force-kills when the child never actually exits, even though child.killed is already true', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const fakeChild = makeFakeChild()
  const { mod, restore } = loadServerWithMockedSpawn(() => fakeChild)
  try {
    mod.startShinyWithCoverage({ wait: false })

    process.emit('SIGTERM')
    // Signal was sent -- child.killed is true immediately, as it always is
    // in real child_process, regardless of whether the process actually died.
    assert.strictEqual(fakeChild.killed, true)
    assert.strictEqual(fakeChild.lastKillSignal, 'SIGTERM')

    // No 'exit' event was ever emitted -- the child is still alive. Advance
    // past the 5s escalation window: the escalation must check actual exit
    // (not child.killed, which is already true) to fire correctly here.
    t.mock.timers.tick(5000)

    assert.strictEqual(fakeChild.lastKillSignal, 'SIGKILL')
  } finally {
    restore()
  }
})

test('package.json exports "./server", so require("shiny.cov-cypress/server") resolves', () => {
  // Self-reference resolution (a package requiring itself by name) goes
  // through the same "exports" map as an external consumer would.
  const mod = require('shiny.cov-cypress/server')
  assert.strictEqual(typeof mod.startShinyWithCoverage, 'function')
})

test('SIGINT handler also escalates to SIGKILL when the child never actually exits', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const fakeChild = makeFakeChild()
  const { mod, restore } = loadServerWithMockedSpawn(() => fakeChild)
  try {
    mod.startShinyWithCoverage({ wait: false })

    process.emit('SIGINT')
    // Signal was sent -- child.killed is true immediately, same as SIGTERM.
    assert.strictEqual(fakeChild.killed, true)
    assert.strictEqual(fakeChild.lastKillSignal, 'SIGINT')

    // No 'exit' event was ever emitted -- the child is still alive. Advance
    // past the 5s escalation window, mirroring the SIGTERM handler's own
    // escalation logic above.
    t.mock.timers.tick(5000)

    assert.strictEqual(fakeChild.lastKillSignal, 'SIGKILL')
  } finally {
    restore()
  }
})

test('SIGINT handler does NOT force-kill once the child has actually exited', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const fakeChild = makeFakeChild()
  const { mod, restore } = loadServerWithMockedSpawn(() => fakeChild)
  try {
    mod.startShinyWithCoverage({ wait: false })

    process.emit('SIGINT')
    assert.strictEqual(fakeChild.lastKillSignal, 'SIGINT')

    // The child actually exits in response to SIGINT this time.
    fakeChild.emit('exit', null, 'SIGINT')

    t.mock.timers.tick(5000)

    // No escalation -- last signal sent is still the original SIGINT.
    assert.strictEqual(fakeChild.lastKillSignal, 'SIGINT')
  } finally {
    restore()
  }
})

test('SIGKILL fallback does NOT force-kill once the child has actually exited', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const fakeChild = makeFakeChild()
  const { mod, restore } = loadServerWithMockedSpawn(() => fakeChild)
  try {
    mod.startShinyWithCoverage({ wait: false })

    process.emit('SIGTERM')
    assert.strictEqual(fakeChild.lastKillSignal, 'SIGTERM')

    // The child actually exits in response to SIGTERM this time.
    fakeChild.emit('exit', null, 'SIGTERM')

    t.mock.timers.tick(5000)

    // No escalation -- last signal sent is still the original SIGTERM.
    assert.strictEqual(fakeChild.lastKillSignal, 'SIGTERM')
  } finally {
    restore()
  }
})
