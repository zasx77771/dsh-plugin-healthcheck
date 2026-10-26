// Verifies the browser half the way the DSH web shell loads it
// (window.__ModuleLoader__.load + require("react")), with no browser and no
// harness packages installed:
//
//   node scripts/verify-client.mjs [path/to/lib/client.js]
//
// Checks:
//   1. apply() registers exactly one settings.section row;
//   2. the row carries a locale-bound label, `locale`, and a fallbackT injector
//      (0.2.x shells no longer always inject `t` into the component);
//   3. apply() does not throw when the slot service is absent — the failure mode
//      that made the panel vanish silently on DSH 0.2.1.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = resolve(process.argv[2] ?? join(root, 'lib', 'client.js'))

let captured
const react = {
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  default: {},
}

globalThis.window = { __ModuleLoader__: { load: (module) => { captured = module } } }

const requireStub = (name) => {
  if (name === 'react') return react
  if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') }
  throw new Error(`unexpected module require: ${name}`)
}

const source = readFileSync(bundle, 'utf8')
new Function('window', `${source}\nreturn undefined;`)(globalThis.window)
if (captured === undefined) throw new Error('bundle never called window.__ModuleLoader__.load')

const mod = captured.factory(requireStub)
if (typeof mod.apply !== 'function') throw new Error('bundle exports no apply()')

let registered
const makeCtx = (withSlots) => {
  const ctx = {
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get: (name) => (name === 'slots' && withSlots ? ctx.slots : undefined),
    locale: { register: () => () => {}, bind: (ns) => (key) => `${ns}:${key}` },
  }
  if (withSlots) {
    ctx.slots = {
      inject: (name, callback) => callback(),
      register: (definition) => { registered = definition },
    }
  }
  return ctx
}

const results = []
const check = (ok, detail) => results.push([ok, detail])

mod.apply(makeCtx(true))
check(registered !== undefined, 'settings.section row registered')
if (registered !== undefined) {
  const label = registered.label()
  const injected = registered.inject?.() ?? {}
  check(registered.name === 'settings.section', `name=${registered.name}`)
  check(registered.id === 'plugin-healthcheck', `id=${registered.id}`)
  check(registered.order === 80, `order=${registered.order}`)
  check(registered.locale === 'plugin-healthcheck', `locale=${registered.locale}`)
  check(label === 'plugin-healthcheck:nav', `label=${label}`)
  check(typeof injected.fallbackT === 'function', 'inject().fallbackT is a function')
  check(injected.fallbackT?.('nav') === 'plugin-healthcheck:nav', `fallbackT('nav')=${injected.fallbackT?.('nav')}`)
}

try {
  registered = undefined
  mod.apply(makeCtx(false))
  check(registered === undefined, 'no slots => no throw, no registration')
} catch (error) {
  check(false, `no slots => threw: ${error.message}`)
}

let failed = false
console.log(`module: ${captured.id}`)
console.log(`inject: ${JSON.stringify(mod.inject)}`)
for (const [ok, detail] of results) {
  if (!ok) failed = true
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${detail}`)
}
console.log(failed ? '\nclient half: FAILED' : '\nclient half: OK')
process.exit(failed ? 1 : 0)
