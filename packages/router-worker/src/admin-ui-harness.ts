/**
 * Test-only stub-DOM harness that executes the FULL served admin client
 * script (never a reconstructed fragment) against recorded storages, fetch,
 * and timers. Used by router.test.ts and admin-ui-mesh.test.ts.
 */

type StubListener = (event?: unknown) => unknown

export interface StubElement {
  id: string
  tagName: string
  textContent: string
  value: string
  checked: boolean
  selected: boolean
  disabled: boolean
  hidden: boolean
  type: string
  name: string
  className: string
  dataset: Record<string, string>
  attributes: Record<string, string>
  children: StubElement[]
  listeners: Map<string, StubListener>
  classList: {
    add: (...names: string[]) => void
    remove: (...names: string[]) => void
    toggle: (name: string, enabled?: boolean) => boolean
    contains: (name: string) => boolean
  }
  setAttribute: (name: string, value: string) => void
  getAttribute: (name: string) => string | null
  removeAttribute: (name: string) => void
  addEventListener: (name: string, listener: StubListener) => void
  append: (...nodes: StubElement[]) => void
  appendChild: (node: StubElement) => StubElement
  prepend: (...nodes: StubElement[]) => void
  querySelector: (selector: string) => StubElement | undefined
  closest: (selector: string) => StubElement | null
  scrollIntoView: (options?: unknown) => void
  focus: (options?: unknown) => void
}

function matchesSimpleSelector(element: StubElement, selector: string): boolean {
  const withValue = selector.match(/^\[data-([a-z-]+)="([^"]*)"\]$/)
  if (withValue) {
    const key = withValue[1]!.replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase())
    return element.dataset[key] === withValue[2]
  }
  const presence = selector.match(/^\[data-([a-z-]+)\]$/)
  if (presence) {
    const key = presence[1]!.replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase())
    return Object.prototype.hasOwnProperty.call(element.dataset, key)
  }
  return false
}

export function elementStub(overrides: Partial<StubElement> = {}): StubElement {
  const classes = new Set<string>()
  let text = ''
  const base: StubElement = {
    id: '',
    tagName: 'div',
    textContent: '',
    value: '',
    checked: false,
    selected: false,
    disabled: false,
    hidden: false,
    type: '',
    name: '',
    className: '',
    dataset: {},
    attributes: {},
    children: [],
    listeners: new Map<string, StubListener>(),
    classList: {
      add: (...names: string[]) => { names.forEach((name) => classes.add(name)) },
      remove: (...names: string[]) => { names.forEach((name) => classes.delete(name)) },
      toggle: (name: string, enabled?: boolean) => {
        const next = enabled ?? !classes.has(name)
        if (next) classes.add(name)
        else classes.delete(name)
        return next
      },
      contains: (name: string) => classes.has(name)
    },
    setAttribute(name: string, value: string) {
      this.attributes[name] = value
      if (name.startsWith('data-')) {
        const datasetKey = name.slice(5).replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase())
        this.dataset[datasetKey] = value
      }
    },
    getAttribute(name: string) {
      return name in this.attributes ? this.attributes[name]! : null
    },
    removeAttribute(name: string) {
      delete this.attributes[name]
      if (name.startsWith('data-')) {
        const datasetKey = name.slice(5).replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase())
        delete this.dataset[datasetKey]
      }
    },
    addEventListener(name: string, listener: StubListener) {
      this.listeners.set(name, listener)
    },
    append(...nodes: StubElement[]) {
      this.children.push(...nodes)
    },
    appendChild(node: StubElement) {
      this.children.push(node)
      return node
    },
    prepend(...nodes: StubElement[]) {
      this.children.unshift(...nodes)
    },
    querySelector: () => undefined,
    closest(selector: string) {
      return matchesSimpleSelector(this, selector) ? this : null
    },
    scrollIntoView: () => undefined,
    focus: () => undefined
  }
  // Mirror the DOM contract the client relies on: assigning textContent
  // replaces all children with the given text.
  Object.defineProperty(base, 'textContent', {
    get: () => text,
    set: (value: string) => {
      text = value
      base.children.length = 0
    }
  })
  return Object.assign(base, overrides)
}

/** Flattened descendant walk for assertions on client-rendered trees. */
export function descendants(element: StubElement): StubElement[] {
  return element.children.flatMap((child) => [child, ...descendants(child)])
}

export interface RecordedEvent {
  readonly kind: 'fetch' | 'setItem' | 'removeItem'
  readonly detail: string
}

export interface FetchCall {
  readonly path: string
  readonly init?: RequestInit
}

interface PendingTimer {
  readonly fn: () => void
  readonly delay: number
  cancelled: boolean
}

export interface AdminUiHarness {
  readonly html: string
  readonly config: Record<string, unknown>
  readonly body: StubElement
  readonly events: RecordedEvent[]
  readonly fetchCalls: FetchCall[]
  readonly copied: string[]
  readonly timers: PendingTimer[]
  byId(id: string): StubElement
  query(selector: string): StubElement
  run(): void
  click(target: StubElement): Promise<void>
  clickAction(action: string, dataset?: Record<string, string>, label?: string): Promise<StubElement>
  submit(target: StubElement): Promise<void>
  change(target: StubElement): Promise<void>
  runTimers(): void
  flush(times?: number): Promise<void>
}

export interface HarnessOptions {
  readonly sessionToken?: string
  readonly localToken?: string
}

export function adminUiHarness(html: string, respond: (path: string, init?: RequestInit) => Response | Promise<Response>, options: HarnessOptions = {}): AdminUiHarness {
  const scriptMatch = html.match(/<script>([\s\S]+)<\/script>\s*<\/body>/)
  if (!scriptMatch) throw new Error('served HTML carries no client script')
  const configMatch = html.match(/<script type="application\/json" id="admin-ui-config">([^<]+)<\/script>/)
  if (!configMatch) throw new Error('served HTML carries no admin-ui-config')
  const viewMatch = html.match(/<body data-view="([^"]+)">/)
  if (!viewMatch) throw new Error('served HTML carries no body view mode')

  const elements = new Map<string, StubElement>()
  const byId = (id: string): StubElement => {
    let element = elements.get(id)
    if (!element) {
      element = elementStub({ id })
      elements.set(id, element)
    }
    return element
  }
  byId('admin-ui-config').textContent = configMatch[1]!
  const body = elementStub({ tagName: 'body' })
  body.dataset.view = viewMatch[1]!

  const selectorRegistry = new Map<string, StubElement>()
  const query = (selector: string): StubElement => {
    let element = selectorRegistry.get(selector)
    if (!element) {
      element = elementStub()
      const withValue = selector.match(/^\[data-([a-z-]+)="([^"]*)"\]$/)
      if (withValue) element.setAttribute(`data-${withValue[1]!}`, withValue[2]!)
      selectorRegistry.set(selector, element)
    }
    return element
  }

  const documentListeners = new Map<string, StubListener>()
  // Mirror the DOM contract that assigning an id makes the element reachable
  // via getElementById (the client creates selects with ids it later reads).
  const createElement = (tag: string): StubElement => {
    const element = elementStub({ tagName: tag })
    let idValue = ''
    Object.defineProperty(element, 'id', {
      get: () => idValue,
      set: (value: string) => {
        idValue = value
        if (value) elements.set(value, element)
      }
    })
    return element
  }
  const documentStub = {
    body,
    getElementById: (id: string) => byId(id),
    querySelector: (selector: string) => query(selector),
    createElement,
    addEventListener: (name: string, listener: StubListener) => documentListeners.set(name, listener)
  }

  const events: RecordedEvent[] = []
  const storage = (scope: string, seed?: string) => {
    const data = new Map<string, string>()
    if (seed) data.set('codeflareInferenceMeshAdminToken', seed)
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); events.push({ kind: 'setItem', detail: `${scope}:${key}=${value}` }) },
      removeItem: (key: string) => { data.delete(key); events.push({ kind: 'removeItem', detail: `${scope}:${key}` }) }
    }
  }
  const session = storage('session', options.sessionToken)
  const local = storage('local', options.localToken)

  const fetchCalls: FetchCall[] = []
  const fetchStub = async (path: string, init?: RequestInit): Promise<Response> => {
    fetchCalls.push(init === undefined ? { path } : { path, init })
    events.push({ kind: 'fetch', detail: path })
    return respond(path, init)
  }

  const copied: string[] = []
  const timers: PendingTimer[] = []
  const setTimeoutStub = (fn: () => void, delay: number): number => {
    timers.push({ fn, delay, cancelled: false })
    return timers.length
  }
  const clearTimeoutStub = (handle: number): void => {
    const timer = timers[handle - 1]
    if (timer) timer.cancelled = true
  }

  const dispatch = async (name: string, target: StubElement): Promise<void> => {
    const listener = documentListeners.get(name)
    if (!listener) throw new Error(`no document ${name} listener registered`)
    await listener({ target, preventDefault: () => undefined })
  }

  const harness: AdminUiHarness = {
    html,
    config: JSON.parse(configMatch[1]!) as Record<string, unknown>,
    body,
    events,
    fetchCalls,
    copied,
    timers,
    byId,
    query,
    run() {
      new Function('document', 'sessionStorage', 'localStorage', 'navigator', 'fetch', 'setTimeout', 'clearTimeout', scriptMatch[1]!)(
        documentStub,
        session,
        local,
        { clipboard: { writeText: async (value: string) => { copied.push(value) } } },
        fetchStub,
        setTimeoutStub,
        clearTimeoutStub
      )
    },
    click: (target) => dispatch('click', target),
    async clickAction(action, dataset = {}, label = action) {
      const button = elementStub({ tagName: 'button', textContent: label })
      button.dataset.action = action
      Object.entries(dataset).forEach(([key, value]) => { button.dataset[key] = value })
      await dispatch('click', button)
      return button
    },
    submit: (target) => dispatch('submit', target),
    change: (target) => dispatch('change', target),
    runTimers() {
      const pending = timers.splice(0, timers.length)
      pending.filter((timer) => !timer.cancelled).forEach((timer) => timer.fn())
    },
    async flush(times = 6) {
      for (let index = 0; index < times; index += 1) await Promise.resolve()
    }
  }
  return harness
}
