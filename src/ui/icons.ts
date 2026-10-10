// SmartPick icon helper - setIcon() fails silently (or with an empty/blank
// <svg> placeholder) when the icon id does not exist in the running Obsidian
// version. Older builds (notably Obsidian for Android) ship a smaller lucide
// set, so newer/less common icon ids render as blank buttons. This wrapper
// guarantees a visible button: requested icon -> long-standing core fallback
// icon -> short text label.

import { setIcon } from 'obsidian';

// 'circle' has existed in the lucide set (and Obsidian) for a very long time,
// making it a safe cross-version fallback.
const FALLBACK_ICON_ID = 'circle';

export const DRAWING_PRIMITIVE_SELECTOR =
  'path,circle,rect,line,polyline,polygon,ellipse,use,text,tspan,image';

export function hasDrawableIconContent(el: HTMLElement): boolean {
  const svg = el.querySelector('svg');
  if (!svg) return false;
  // An icon must draw something: at least one drawing primitive. Bare
  // <svg>/<g> placeholders without primitives draw nothing.
  return svg.querySelector(DRAWING_PRIMITIVE_SELECTOR) !== null;
}

function trySetIcon(el: HTMLElement, id: string): boolean {
  try {
    setIcon(el, id);
  } catch {
    return false;
  }
  return hasDrawableIconContent(el);
}

// Last fallback decision, exposed for on-device diagnostics.
let lastDecision = 'none';

export function getLastIconDecision(): string {
  return lastDecision;
}

export function setIconWithFallback(
  el: HTMLElement,
  iconId: string | undefined,
  fallbackText?: string
): void {
  // NOTE: deliberately no getIconIds() membership pre-check here. The id
  // format returned by getIconIds() differs across app versions/platforms,
  // which made valid icons get skipped on some Android builds while direct
  // setIcon() calls work fine there. The behavioral check below observes
  // what setIcon() actually produced on this device, so it always agrees
  // with reality.
  const id = (iconId ?? '').trim();
  if (id && trySetIcon(el, id)) {
    lastDecision = `ok:${id}`;
    return;
  }
  if (trySetIcon(el, FALLBACK_ICON_ID)) {
    lastDecision = `fallback-circle:${id}`;
    return;
  }

  // Last resort: a short text label so the button is never blank.
  try {
    el.empty();
  } catch {
    el.innerHTML = '';
  }
  const label = (fallbackText ?? '').trim().slice(0, 2);
  if (label) {
    el.createSpan({ cls: 'smartpick-icon-fallback-text', text: label });
    lastDecision = `fallback-text:${id}`;
    return;
  }
  lastDecision = `blank:${id}`;
}

export interface ToolbarIconAudit {
  buttons: number;
  svg: number;
  prim: number;
  txt: number;
  empty: number;
}

/** Counts how toolbar buttons actually rendered (for on-device diagnostics). */
export function auditIcons(root: Element | null): ToolbarIconAudit {
  const audit: ToolbarIconAudit = { buttons: 0, svg: 0, prim: 0, txt: 0, empty: 0 };
  if (!root) return audit;
  const btns = root.querySelectorAll('button.smartpick-toolbar-button');
  btns.forEach((b) => {
    audit.buttons++;
    const s = b.querySelector('svg');
    if (s) audit.svg++;
    if (s?.querySelector(DRAWING_PRIMITIVE_SELECTOR)) audit.prim++;
    if (b.querySelector('.smartpick-icon-fallback-text')) audit.txt++;
    if (!s && !b.querySelector('.smartpick-icon-fallback-text') && ((b.textContent ?? '').trim() === '')) {
      audit.empty++;
    }
  });
  return audit;
}

export function formatToolbarAudit(root: Element | null): string {
  const a = auditIcons(root);
  return `btns=${a.buttons} svg=${a.svg} prim=${a.prim} txt=${a.txt} empty=${a.empty}`;
}
