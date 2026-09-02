/**
 * Tests for src/support.js. These commands only ever run inside a real
 * Cypress browser runtime, which isn't available as a plain Node
 * dependency here -- so we mock the minimal `Cypress`/`cy` globals
 * support.js expects (Commands.add, cy.task, cy.log), require the real
 * module against those mocks, and invoke the registered handler functions
 * directly. This exercises the actual shipped logic, not a
 * reimplementation of it.
 */
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')

const discoverBindingsSource = require('../src/vendor/discover-bindings-source.js')

function loadSupportWithMocks(taskResults = {}) {
  const registered = { commands: {}, overwrites: {} }
  const taskCalls = []
  const logCalls = []

  global.Cypress = {
    Commands: {
      add: (name, fn) => { registered.commands[name] = fn },
      overwrite: (name, fn) => { registered.overwrites[name] = fn }
    }
  }
  global.cy = {
    task: (name, payload, opts) => {
      taskCalls.push({ name, payload, opts })
      const result = Object.prototype.hasOwnProperty.call(taskResults, name)
        ? taskResults[name]
        : undefined
      return { then: (cb) => cb(result) }
    },
    log: (msg) => { logCalls.push(msg) }
  }

  delete require.cache[require.resolve('../src/support.js')]
  const exported = require('../src/support.js')

  return { registered, taskCalls, logCalls, exported }
}

test.afterEach(() => {
  delete global.Cypress
  delete global.cy
})

// cy.click()/cy.type()/cy.select()/cy.check()/cy.uncheck() are not
// overridden for auto-logging -- see the "Auto-log overrides: not
// implemented" note in src/support.js for why. cy.shinyCovInteract(),
// tested below, is the supported way to log an interaction.

test('shinyCovInteract logs the given selector/action/value verbatim', () => {
  const { registered, taskCalls } = loadSupportWithMocks()

  registered.commands.shinyCovInteract('#bins', 'set_inputs', 20)

  assert.strictEqual(taskCalls[0].name, 'shinyCovLog')
  assert.deepStrictEqual(taskCalls[0].payload.selector, '#bins')
  assert.strictEqual(taskCalls[0].payload.action, 'set_inputs')
  assert.strictEqual(taskCalls[0].payload.value, 20)
})

test('shinyCovManifest returns the manifest when the task finds one', () => {
  const manifest = { inputs: [{ id: 'choice' }], outputs: [], tabs: [], conditional: [], modules: [] }
  const { registered } = loadSupportWithMocks({ shinyCovReadManifest: manifest })

  const result = registered.commands.shinyCovManifest()

  assert.deepStrictEqual(result, manifest)
})

test('shinyCovManifest falls back to an empty manifest when the task finds nothing', () => {
  const { registered, logCalls } = loadSupportWithMocks({ shinyCovReadManifest: null })

  const result = registered.commands.shinyCovManifest()

  assert.deepStrictEqual(result, { inputs: [], outputs: [], tabs: [], conditional: [], modules: [] })
  assert.strictEqual(logCalls.length, 1)
})

// ---- discover-bindings.js: exercised via the real vendored source
// (src/vendor/discover-bindings-source.js) run in a node:vm context built
// from a hand-built minimal DOM/Shiny mock, since a real browser isn't
// available as a plain Node dependency here. Coverage: a plain input, an
// actionButton, and a hand-registered custom binding, all discovered
// generically via the Shiny.inputBindings registry rather than CSS classes.

function makeMockWindow({
  inputBindings = {}, outputBindings = {}, labels = {},
  tabPanes = [], toggleLinks = [], conditionalIds = []
} = {}) {
  function makeRegistry(bindingsMap) {
    const bindingNames = {}
    for (const name of Object.keys(bindingsMap)) {
      const elements = bindingsMap[name]
      bindingNames[name] = { binding: { find: () => elements, getId: (el) => el.id } }
    }
    return { bindingNames }
  }

  const querySelectorAllMap = {
    '.tab-pane[title]': tabPanes.map((title) => ({ getAttribute: (a) => (a === 'title' ? title : null) })),
    'a[data-toggle]': toggleLinks.map((text) => ({ textContent: text })),
    '.shiny-panel-conditional[id]': conditionalIds.map((id) => ({ id }))
  }

  const win = {
    CSS: { escape: (s) => s },
    Shiny: {
      inputBindings: makeRegistry(inputBindings),
      outputBindings: makeRegistry(outputBindings)
    },
    document: {
      querySelector: (sel) => {
        const m = sel.match(/label\[for="(.+)"\]/)
        if (m && labels[m[1]]) return { textContent: labels[m[1]] }
        return null
      },
      querySelectorAll: (sel) => querySelectorAllMap[sel] || []
    }
  }

  // discover-bindings.js references bare window/document/CSS globals (it's
  // shared verbatim with the R side, which evaluates it in a real page
  // context). A vm.Context whose global object exposes those same three
  // names, pointing at this mock, reproduces that resolution without
  // requiring a real browser.
  const evalContext = vm.createContext({ window: win, document: win.document, CSS: win.CSS })
  win.eval = (src) => vm.runInContext(src, evalContext)

  return win
}

function runDiscoverBindingsJs(win) {
  return win.eval(discoverBindingsSource)
}

// vm.createContext() gives discover-bindings.js its own V8 realm, so plain
// objects it constructs (e.g. `{ id: id, type: name }`) carry that realm's
// Object.prototype rather than this test file's -- deepStrictEqual treats
// that as a mismatch even when every property matches. A JSON round-trip
// produces an equivalent value with this realm's prototypes, which is also
// what actually happens on the real path: Cypress's cy.task() IPC
// serializes the manifest to JSON to cross the browser/Node boundary.
function toPlainObject(value) {
  return JSON.parse(JSON.stringify(value))
}

test('discover-bindings.js finds inputs via the binding registry, not CSS classes', () => {
  const win = makeMockWindow({
    inputBindings: {
      'shiny.textInput': [{ id: 'name' }],
      'shiny.actionButtonInput': [{ id: 'greet' }], // action buttons are discovered via the bindings registry like any other input
      'demo.customWidget': [{ id: 'weird' }] // stands in for e.g. shiny.fluent
    },
    labels: { name: 'Your name' }
  })

  const manifest = runDiscoverBindingsJs(win)

  assert.deepStrictEqual(toPlainObject(manifest.inputs), [
    { id: 'name', type: 'shiny.textInput', label: 'Your name' },
    { id: 'greet', type: 'shiny.actionButtonInput', label: '' },
    { id: 'weird', type: 'demo.customWidget', label: '' }
  ])
})

test('discover-bindings.js dedupes an id matched by multiple bindings, preferring the more specific one', () => {
  const win = makeMockWindow({
    inputBindings: {
      'shiny.textInput': [{ id: 'weird' }],
      'demo.customWidget': [{ id: 'weird' }]
    }
  })

  const manifest = runDiscoverBindingsJs(win)

  assert.strictEqual(manifest.inputs.length, 1)
  assert.strictEqual(manifest.inputs[0].type, 'demo.customWidget')
})

test('discover-bindings.js finds outputs, tabs, and conditional panels', () => {
  const win = makeMockWindow({
    outputBindings: { 'shiny.textOutput': [{ id: 'out' }] },
    tabPanes: ['Main', 'About'],
    conditionalIds: ['onlyWhenShow']
  })

  const manifest = runDiscoverBindingsJs(win)

  assert.deepStrictEqual(toPlainObject(manifest.outputs), [{ id: 'out', type: 'shiny.textOutput' }])
  assert.deepStrictEqual(toPlainObject(manifest.tabs), ['Main', 'About'])
  assert.deepStrictEqual(toPlainObject(manifest.conditional), ['onlyWhenShow'])
})

test('shinyCovDiscoverManifest sends the discovered manifest to the write task', () => {
  const { registered, taskCalls } = loadSupportWithMocks()
  global.cy.window = ({ log } = {}) => ({
    then: (cb) => cb(makeMockWindow({ inputBindings: { 'shiny.actionButtonInput': [{ id: 'greet' }] } }))
  })

  registered.commands.shinyCovDiscoverManifest()

  const writeCall = taskCalls.find((c) => c.name === 'shinyCovWriteManifest')
  assert.ok(writeCall, 'shinyCovWriteManifest task should have been called')
  assert.deepStrictEqual(toPlainObject(writeCall.payload.inputs), [{ id: 'greet', type: 'shiny.actionButtonInput', label: '' }])
})
