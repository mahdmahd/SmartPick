// SmartPick icon helper - setIcon() fails silently (or with an empty/blank
// <svg> placeholder) when the icon id does not exist in the running Obsidian
// version. Older builds (notably Obsidian for Android) ship a smaller lucide
// set, so newer/less common icon ids render as blank buttons. This wrapper
// guarantees a visible button: requested icon -> long-standing core fallback
// icon -> short text label.

import { getIconIds, setIcon } from 'obsidian';

// 'circle' has existed in the lucide set (and Obsidian) for a very long time,
// making it a safe cross-version fallback.
const FALLBACK_ICON_ID = 'circle';

export const DRAWING_PRIMITIVE_SELECTOR =
  'path,circle,rect,line,polyline,polygon,ellipse,use,text,tspan,image';

let cachedKnownIds: Set<string> | null | undefined;

function knownIconExists(id: string): boolean | null {
  // Returns null when the running app has no icon-listing API (unknown).
  try {
    if (cachedKnownIds === undefined) {
      const ids = getIconIds();
      cachedKnownIds = Array.isArray(ids) ? new Set(ids) : null;
    }
    if (cachedKnownIds === null) return null;
    return cachedKnownIds.has(id);
  } catch {
    return null;
  }
}

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

export function setIconWithFallback(
  el: HTMLElement,
  iconId: string | undefined,
  fallbackText?: string
): void {
  const id = (iconId ?? '').trim();
  if (id && knownIconExists(id) !== false && trySetIcon(el, id)) return;
  if (knownIconExists(FALLBACK_ICON_ID) !== false && trySetIcon(el, FALLBACK_ICON_ID)) return;

  // Last resort: a short text label so the button is never blank.
  try {
    el.empty();
  } catch {
    el.innerHTML = '';
  }
  const label = (fallbackText ?? '').trim().slice(0, 2);
  if (label) {
    el.createSpan({ cls: 'smartpick-icon-fallback-text', text: label });
  }
}
