/**
 * Composable string components for the admin console. Structure lives here,
 * content is passed in by the views, and every size/colour comes from the
 * token block in admin-ui-css.ts. Anything rendered more than twice is one
 * of these functions.
 */

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]!))
}

/** Field anatomy contract: visible label + control + optional inline hint. */
export const ADMIN_UI_FIELD_ANCHOR = {
  className: 'field',
  labelledControls: ['input', 'select'] as const
} as const

export interface FieldOptions {
  readonly id: string
  readonly label: string
  readonly control: string
  readonly hint?: string
}

export function field(options: FieldOptions): string {
  const hint = options.hint ? `<span class="field-hint" id="${escapeHtml(options.id)}-hint">${escapeHtml(options.hint)}</span>` : ''
  return `<div class="${ADMIN_UI_FIELD_ANCHOR.className}" data-field="${escapeHtml(options.id)}"><label for="${escapeHtml(options.id)}">${escapeHtml(options.label)}</label>${options.control}${hint}</div>`
}

export interface TextInputOptions {
  readonly id: string
  readonly name: string
  readonly placeholder?: string
  readonly type?: 'text' | 'password' | 'number'
  readonly autocomplete?: string
  readonly inputmode?: string
  readonly value?: string
  readonly min?: number
  readonly max?: number
  readonly describedBy?: boolean
}

export function textInput(options: TextInputOptions): string {
  const attrs = [
    `id="${escapeHtml(options.id)}"`,
    `name="${escapeHtml(options.name)}"`,
    `type="${options.type ?? 'text'}"`,
    options.placeholder ? `placeholder="${escapeHtml(options.placeholder)}"` : '',
    options.autocomplete ? `autocomplete="${escapeHtml(options.autocomplete)}"` : 'autocomplete="off"',
    options.inputmode ? `inputmode="${escapeHtml(options.inputmode)}"` : '',
    options.value !== undefined ? `value="${escapeHtml(options.value)}"` : '',
    options.min !== undefined ? `min="${options.min}"` : '',
    options.max !== undefined ? `max="${options.max}"` : '',
    options.describedBy ? `aria-describedby="${escapeHtml(options.id)}-hint"` : ''
  ].filter(Boolean).join(' ')
  return `<input ${attrs}>`
}

export interface ButtonOptions {
  readonly action: string
  readonly label: string
  readonly variant?: 'primary' | 'ghost' | 'danger'
  readonly out?: string
  readonly confirm?: string
  readonly prefix?: string
}

export function button(options: ButtonOptions): string {
  const variantClass = options.variant === 'primary' ? ' btn-primary' : options.variant === 'ghost' ? ' btn-ghost' : options.variant === 'danger' ? ' btn-danger' : ''
  const attrs = [
    `class="btn${variantClass}"`,
    'type="button"',
    `data-action="${escapeHtml(options.action)}"`,
    options.out ? `data-out="${escapeHtml(options.out)}"` : '',
    options.confirm ? `data-confirm="${escapeHtml(options.confirm)}"` : '',
    options.prefix ? `data-prefix="${escapeHtml(options.prefix)}"` : ''
  ].filter(Boolean).join(' ')
  return `<button ${attrs}>${escapeHtml(options.label)}</button>`
}

export interface PanelOptions {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly actions?: string
  readonly body: string
  readonly active?: boolean
}

/** Dashboard section panel; exactly one is active at a time. */
export function sectionPanel(options: PanelOptions): string {
  return `<section class="panel section-panel" id="${escapeHtml(options.id)}" data-section="${escapeHtml(options.id)}" data-active="${options.active === true ? 'true' : 'false'}" aria-labelledby="${escapeHtml(options.id)}-title">
<div class="panel-head"><h2 id="${escapeHtml(options.id)}-title">${escapeHtml(options.title)}</h2>${options.actions ?? ''}<p>${escapeHtml(options.description)}</p></div>
${options.body}
</section>`
}

export interface NavItemOptions {
  readonly section: string
  readonly label: string
  readonly hint: string
  readonly current?: boolean
}

export function navItem(options: NavItemOptions): string {
  return `<a class="nav-item" href="#${escapeHtml(options.section)}" data-nav="${escapeHtml(options.section)}"${options.current === true ? ' aria-current="page"' : ''}><span>${escapeHtml(options.label)}</span><small>${escapeHtml(options.hint)}</small></a>`
}

export interface TabItemOptions {
  readonly tab: string
  readonly label: string
  readonly glyph: string
  readonly current?: boolean
}

export function tabItem(options: TabItemOptions): string {
  return `<button class="tab-item" type="button" data-tab="${escapeHtml(options.tab)}"${options.current === true ? ' aria-current="page"' : ''}><span class="tab-glyph" aria-hidden="true">${escapeHtml(options.glyph)}</span><span>${escapeHtml(options.label)}</span></button>`
}

export interface WizardStepOptions {
  readonly step: string
  readonly title: string
  readonly description: string
  readonly body: string
  readonly active?: boolean
}

export function wizardStep(options: WizardStepOptions): string {
  return `<section class="gate-card wizard-step" id="step-${escapeHtml(options.step)}" data-step-panel="${escapeHtml(options.step)}"${options.active === true ? '' : ' hidden'} aria-labelledby="step-${escapeHtml(options.step)}-title">
<h2 id="step-${escapeHtml(options.step)}-title">${escapeHtml(options.title)}</h2>
<p>${escapeHtml(options.description)}</p>
${options.body}
</section>`
}

export function stepper(steps: readonly { readonly step: string; readonly label: string }[], currentStep: string): string {
  const items = steps
    .map((item) => `<li data-step="${escapeHtml(item.step)}"${item.step === currentStep ? ' aria-current="step"' : ''}><span>${escapeHtml(item.label)}</span></li>`)
    .join('')
  return `<ol class="stepper" data-stepper="${escapeHtml(steps.map((item) => item.step).join(' '))}">${items}</ol>`
}

export interface OutputOptions {
  readonly id: string
  readonly kind: string
  readonly pre?: boolean
  readonly extraClass?: string
}

/** Per-action live feedback region; hidden while empty. */
export function output(options: OutputOptions): string {
  const tag = options.pre === true ? 'pre' : 'div'
  const cls = options.extraClass ? `result ${options.extraClass}` : 'result'
  return `<${tag} class="${cls}" id="${escapeHtml(options.id)}" data-output="${escapeHtml(options.kind)}" role="log" aria-live="polite"></${tag}>`
}
