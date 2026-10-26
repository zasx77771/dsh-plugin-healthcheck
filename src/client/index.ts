/**
 * dsh-plugin-healthcheck — browser half: registers the 插件检测 settings
 * section (the left-bottom settings panel's navigation list). Failure
 * policy: every wiring failure is logged, never thrown — the web shell
 * fails the whole boot when a plugin apply throws.
 * @module dsh-plugin-healthcheck/client
 */

// Type-only: pulls the settings-surface SlotMap merge ('settings.section').
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { HealthcheckSection } from './HealthcheckSection.tsx'
import { NS, en, zh, type HealthcheckKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plugin healthcheck section copy. */
    'plugin-healthcheck': HealthcheckKey
  }
}

/**
 * The slice of the browser-half context this plugin touches.
 *
 * The harness publishes no type package for the 0.2.x client context
 * (`@deepseek-ai/dsh-client-runtime` only exists up to 0.1.0-rc.6), so the
 * shape is declared locally instead of imported.
 */
export interface HealthcheckClientContext {
  /** Register a disposable owned by this plugin. */
  effect: (fn: () => void | (() => void), label?: string) => void
  /** Resolve an optional service without making it a hard inject. */
  get: (name: string) => unknown
  /** Locale service. */
  locale: {
    register: (ns: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }) => () => void
    bind: (ns: string) => (key: HealthcheckKey) => string
  }
  /** Slot service (also reachable through `get('slots')`). */
  slots: HealthcheckSlots
}

/** The slice of the slot service this plugin touches. */
export interface HealthcheckSlots {
  inject: (name: 'settings.section', callback: () => void) => void
  register: (definition: {
    name: 'settings.section'
    id: string
    order?: number
    label: () => string
    locale?: string
    inject?: () => Record<string, unknown>
  }, component: unknown) => void
}

/** Required services. */
export const inject = ['slots', 'locale']

/**
 * Apply the browser half: dictionaries, then one settings.section entry.
 *
 * The slot lookup is defensive (`ctx.get` instead of `ctx.slots`) so a
 * harness build without the slot service logs nothing and simply shows no
 * panel, instead of failing the whole client boot.
 * @param ctx - client root context.
 */
export function apply(ctx: HealthcheckClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-healthcheck: dictionaries')

  const slots = (ctx.get('slots') ?? ctx.slots) as HealthcheckSlots | undefined
  if (slots === undefined) return

  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'plugin-healthcheck',
    order: 80,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
    inject: () => ({ fallbackT: ctx.locale.bind(NS) }),
  }, HealthcheckSection))
}
