// Offline smoke test for the hand-written client bundle.
//
// The harness bundles React inside its frontend, so no react copy exists on disk
// to render with. This script stubs the loader and a minimal hooks engine, runs
// `apply`, then executes the settings component and walks the returned element
// tree — enough to catch the failure modes that would break the app: async
// factories, apply() throwing, and render-time crashes.
//
//   node scripts/verify-client.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

const failures = []
function check(name, condition, detail) {
  if (condition) {
    console.log(`ok   ${name}`)
    return
  }
  failures.push(name)
  console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ── stubs ───────────────────────────────────────────────────────────────────

let captured
const effects = []
let hookCursor = 0
let hookValues = []

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() }
  },
  useState(initial) {
    const index = hookCursor
    hookCursor += 1
    if (hookValues.length <= index) hookValues[index] = initial
    const set = (next) => {
      hookValues[index] = typeof next === 'function' ? next(hookValues[index]) : next
    }
    return [hookValues[index], set]
  },
  useEffect(effect) {
    effects.push(effect)
  },
}

globalThis.window = {
  __ModuleLoader__: {
    load(module) {
      captured = module
    },
  },
}

const fetchCalls = []
globalThis.fetch = async (path) => {
  fetchCalls.push(String(path))
  return {
    status: 200,
    json: async () => ({
      ok: true,
      value: {
        profileName: 'desktop',
        profile: [{ name: 'dsh-mnemon' }],
        builtin: [],
        counts: { profile: 19, builtin: 190, total: 209 },
      },
    }),
  }
}

const requireShim = (spec) => {
  if (spec === 'react') return React
  throw new Error(`unexpected require: ${spec}`)
}

// ── load + apply ────────────────────────────────────────────────────────────

// eslint-disable-next-line no-new-func
new Function('window', source)(globalThis.window)
check('bundle registers a module with the loader', captured !== undefined)
check('module id matches the package name', captured?.id === 'dsh-plugin-healthcheck', captured?.id)

const exportsObject = captured.factory(requireShim)
check('exports.name', exportsObject.name === 'dsh-plugin-healthcheck', exportsObject.name)
check('exports.inject lists slots+locale', JSON.stringify(exportsObject.inject) === '["slots","locale"]', JSON.stringify(exportsObject.inject))
check('exports.apply is callable', typeof exportsObject.apply === 'function')

let registered
const slots = {
  inject(name, factory) {
    registered = { name, contribution: factory() }
  },
  register(options, component) {
    return { options, component }
  },
}

exportsObject.apply({ get: () => slots, locale: { bind: () => (key) => key } })
check('registers into settings.section', registered?.name === 'settings.section', registered?.name)
check('contribution id', registered?.contribution?.options?.id === 'dsh-plugin-healthcheck')
check('contribution order', registered?.contribution?.options?.order === 80)
check('contribution label is 插件检测', registered?.contribution?.options?.label?.() === '插件检测')
check('component provided', typeof registered?.contribution?.component === 'function')

let threw = false
try {
  exportsObject.apply({ get: () => undefined })
} catch {
  threw = true
}
check('apply tolerates a missing slots service', threw === false)

// ── render, run effects, re-render ──────────────────────────────────────────

function renderToString(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(renderToString).join('')
  if (typeof node.type === 'function') return renderToString(node.type(node.props))
  const inner = (node.children ?? []).map(renderToString).join('')
  return `<${node.type}>${inner}</${node.type}>`
}

let tree = ''
try {
  hookCursor = 0
  hookValues = []
  tree = renderToString(registered.contribution.component({ fallbackT: (key) => key }))
} catch (error) {
  check('component renders', false, String(error && error.stack))
}

check('render shows the page title', tree.includes('插件检测'), tree.slice(0, 120))

try {
  for (const effect of effects) {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanup()
  }
  await new Promise((resolve) => setTimeout(resolve, 20))
  hookCursor = 0
  const again = renderToString(registered.contribution.component({ fallbackT: (key) => key }))
  check('inventory data lands in the DOM', again.includes('配置集 desktop'), again.slice(0, 240))
  check('plugin count rendered', again.includes('19'), again.slice(0, 240))
} catch (error) {
  check('effects run cleanly', false, String(error && error.message))
}

console.log(failures.length === 0 ? '\nall checks passed' : `\n${failures.length} check(s) failed`)
process.exitCode = failures.length === 0 ? 0 : 1
