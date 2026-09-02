const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const shinyCovPlugin = require('../src/plugin.js')

function setupPlugin() {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shinycov-plugin-test-'))
  const shinyCovDir = path.join(appDir, '.shiny.cov')
  fs.mkdirSync(shinyCovDir)

  const tasks = {}
  const hooks = {}
  const on = (event, handlerOrTasks) => {
    if (event === 'task') Object.assign(tasks, handlerOrTasks)
    else hooks[event] = handlerOrTasks
  }
  const config = { env: { shinyCovAppDir: appDir }, baseUrl: undefined }

  shinyCovPlugin(on, config)

  return { appDir, shinyCovDir, tasks, hooks, config }
}

test('registers the expected tasks', () => {
  const { tasks } = setupPlugin()
  for (const name of ['shinyCovReadManifest', 'shinyCovWriteManifest', 'shinyCovLog', 'shinyCovGetLog', 'shinyCovClearLog', 'shinyCovInteractionCount', 'shinyCovWriteLog']) {
    assert.strictEqual(typeof tasks[name], 'function', `${name} should be registered`)
  }
})

test('shinyCovWriteManifest writes and shinyCovReadManifest reads it back', () => {
  const { tasks } = setupPlugin()
  const manifest = {
    inputs: [{ id: 'greet', type: 'shiny.actionButtonInput', label: '' }],
    outputs: [{ id: 'out', type: 'shiny.textOutput' }],
    tabs: ['Main'],
    conditional: [],
    modules: []
  }

  const writtenPath = tasks.shinyCovWriteManifest(manifest)

  assert.ok(writtenPath)
  assert.deepStrictEqual(tasks.shinyCovReadManifest(), manifest)
})

test('shinyCovWriteManifest merges with a previous write, preferring the more specific type', () => {
  // A widget library can strip its own distinguishing class after
  // interaction (e.g. shinyWidgets::pickerInput() loses `.selectpicker`
  // once its value changes), so a *later* snapshot can look less specific
  // than an *earlier* one for the same id -- the earlier snapshot must win.
  const { tasks } = setupPlugin()

  const firstSnapshot = {
    inputs: [{ id: 'picker_1', type: 'shinyWidgets.pickerInput', label: 'Picker 1' }],
    outputs: [],
    tabs: [],
    conditional: [],
    modules: []
  }
  const laterSnapshotAfterInteraction = {
    inputs: [{ id: 'picker_1', type: 'shiny.selectInput', label: '' }],
    outputs: [],
    tabs: [],
    conditional: [],
    modules: []
  }

  tasks.shinyCovWriteManifest(firstSnapshot)
  tasks.shinyCovWriteManifest(laterSnapshotAfterInteraction)

  const merged = tasks.shinyCovReadManifest()
  assert.strictEqual(merged.inputs.length, 1)
  assert.strictEqual(merged.inputs[0].type, 'shinyWidgets.pickerInput')
  assert.strictEqual(merged.inputs[0].label, 'Picker 1')
})

test('shinyCovReadManifest returns null when manifest.json is missing', () => {
  const { tasks } = setupPlugin()
  assert.strictEqual(tasks.shinyCovReadManifest(), null)
})

test('shinyCovReadManifest reads back a real manifest.json written by the R side', () => {
  const { shinyCovDir, tasks } = setupPlugin()
  const manifest = { inputs: [{ id: 'choice', type: 'selectInput' }], outputs: [], tabs: ['Main'], conditional: [], modules: [] }
  fs.writeFileSync(path.join(shinyCovDir, 'manifest.json'), JSON.stringify(manifest))

  assert.deepStrictEqual(tasks.shinyCovReadManifest(), manifest)
})

test('shinyCovLog/shinyCovGetLog/shinyCovClearLog round-trip an interaction', () => {
  const { tasks } = setupPlugin()

  assert.strictEqual(tasks.shinyCovGetLog().length, 0)
  tasks.shinyCovLog({ selector: '#choice', action: 'set_inputs', value: 'b' })
  const log = tasks.shinyCovGetLog()

  assert.strictEqual(log.length, 1)
  assert.strictEqual(log[0].selector, '#choice')
  assert.strictEqual(log[0].action, 'set_inputs')
  assert.strictEqual(tasks.shinyCovInteractionCount(), 1)

  tasks.shinyCovClearLog()
  assert.strictEqual(tasks.shinyCovGetLog().length, 0)
})

test('shinyCovLog ignores entries with no selector', () => {
  const { tasks } = setupPlugin()
  tasks.shinyCovLog({ action: 'click' })
  assert.strictEqual(tasks.shinyCovGetLog().length, 0)
})

test('shinyCovWriteLog persists the log to interactions.json', () => {
  const { shinyCovDir, tasks } = setupPlugin()
  tasks.shinyCovLog({ selector: '#greet', action: 'click' })

  const writtenPath = tasks.shinyCovWriteLog()

  assert.strictEqual(writtenPath, path.join(shinyCovDir, 'interactions.json'))
  const onDisk = JSON.parse(fs.readFileSync(writtenPath, 'utf8'))
  assert.strictEqual(onDisk.length, 1)
  assert.strictEqual(onDisk[0].selector, '#greet')
})

test('shinyCovWriteLog flushes and clears the in-memory log', () => {
  const { tasks } = setupPlugin()
  tasks.shinyCovLog({ selector: '#greet', action: 'click' })

  tasks.shinyCovWriteLog()

  assert.strictEqual(tasks.shinyCovGetLog().length, 0)
})

test('shinyCovWriteLog merges with a previous flush instead of overwriting it', () => {
  // Two flushes in the same run (e.g. two spec files, each calling
  // shinyCovWriteLog from their own after() hook) must both survive on
  // disk -- a plain overwrite would let only the second spec's entries
  // survive.
  const { shinyCovDir, tasks } = setupPlugin()

  tasks.shinyCovLog({ selector: '#a', action: 'click' })
  tasks.shinyCovWriteLog()

  tasks.shinyCovLog({ selector: '#b', action: 'click' })
  tasks.shinyCovWriteLog()

  const onDisk = JSON.parse(fs.readFileSync(path.join(shinyCovDir, 'interactions.json'), 'utf8'))
  assert.strictEqual(onDisk.length, 2)
  assert.deepStrictEqual(onDisk.map((e) => e.selector), ['#a', '#b'])
})

test('multi-spec sequence: log -> flush -> before:spec -> log -> flush keeps both specs\' entries', () => {
  // Simulates a real Cypress multi-spec-file run: spec 1 logs an
  // interaction and flushes it (its own after() hook calling
  // shinyCovWriteLog), Cypress fires before:spec for spec 2, spec 2 logs
  // its own interaction and flushes. Both must be present in the final
  // interactions.json.
  const { shinyCovDir, tasks, hooks } = setupPlugin()

  tasks.shinyCovLog({ selector: '#a', action: 'click' })
  tasks.shinyCovWriteLog()

  hooks['before:spec']()
  assert.strictEqual(tasks.shinyCovGetLog().length, 0)

  tasks.shinyCovLog({ selector: '#b', action: 'click' })
  tasks.shinyCovWriteLog()

  const onDisk = JSON.parse(fs.readFileSync(path.join(shinyCovDir, 'interactions.json'), 'utf8'))
  assert.strictEqual(onDisk.length, 2)
  assert.deepStrictEqual(onDisk.map((e) => e.selector), ['#a', '#b'])
})

test('after:run flushes anything left unflushed as a safety net', () => {
  const { shinyCovDir, tasks, hooks } = setupPlugin()
  tasks.shinyCovLog({ selector: '#b', action: 'click' })
  hooks['after:run']()

  const onDisk = JSON.parse(fs.readFileSync(path.join(shinyCovDir, 'interactions.json'), 'utf8'))
  assert.strictEqual(onDisk.length, 1)
  assert.strictEqual(onDisk[0].selector, '#b')
})

test('before:spec warns AND flushes a non-empty, never-flushed log instead of discarding it', () => {
  // A spec that forgets to call shinyCovWriteLog() must not lose its
  // interactions just because a later spec starts -- the after:run safety
  // net only ever sees the *last* spec's leftovers, not an earlier spec's,
  // so before:spec must flush a non-empty log itself (after warning).
  const { shinyCovDir, tasks, hooks } = setupPlugin()
  tasks.shinyCovLog({ selector: '#a', action: 'click' })

  const originalWarn = console.warn
  const warnCalls = []
  console.warn = (...args) => { warnCalls.push(args) }
  try {
    hooks['before:spec']()
  } finally {
    console.warn = originalWarn
  }

  assert.strictEqual(warnCalls.length, 1)
  assert.match(warnCalls[0][0], /never flushed/)
  assert.strictEqual(tasks.shinyCovGetLog().length, 0)

  const onDisk = JSON.parse(fs.readFileSync(path.join(shinyCovDir, 'interactions.json'), 'utf8'))
  assert.strictEqual(onDisk.length, 1)
  assert.strictEqual(onDisk[0].selector, '#a')
})

test('shinyCovWriteLog aborts the flush (does not overwrite) if the existing interactions.json is corrupted', () => {
  const { shinyCovDir, tasks } = setupPlugin()
  fs.mkdirSync(shinyCovDir, { recursive: true })
  const interactionsPath = path.join(shinyCovDir, 'interactions.json')
  fs.writeFileSync(interactionsPath, '{ this is not valid json')

  tasks.shinyCovLog({ selector: '#a', action: 'click' })
  tasks.shinyCovWriteLog()

  // The corrupted file on disk must survive untouched -- a flush that
  // can't read the existing file must not blindly overwrite it with just
  // the current in-memory batch, which would permanently destroy whatever
  // was already flushed there.
  const onDisk = fs.readFileSync(interactionsPath, 'utf8')
  assert.strictEqual(onDisk, '{ this is not valid json')
  // In-memory entries are preserved for a retry, not discarded.
  assert.strictEqual(tasks.shinyCovGetLog().length, 1)
})

test('before:spec does not warn when the log is already empty', () => {
  const { hooks } = setupPlugin()

  const originalWarn = console.warn
  const warnCalls = []
  console.warn = (...args) => { warnCalls.push(args) }
  try {
    hooks['before:spec']()
  } finally {
    console.warn = originalWarn
  }

  assert.strictEqual(warnCalls.length, 0)
})

test('defaults baseUrl to 127.0.0.1:3333, not localhost, when not configured', () => {
  // Node 17+ resolves "localhost" to the IPv6 loopback first, but
  // shiny::runApp() only binds IPv4 127.0.0.1 -- the same mismatch
  // documented in server.js and the README's Quick Start.
  const { config } = setupPlugin()
  assert.strictEqual(config.baseUrl, 'http://127.0.0.1:3333')
})
