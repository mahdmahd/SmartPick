// SmartPick icon helper - setIcon() leaves the element empty when the icon id
// does not exist in the running Obsidian version. Older builds (notably
// Obsidian for Android) ship a smaller lucide set, so newer/less common icon
// ids render as blank buttons. This wrapper guarantees a visible button:
// requested icon -> long-standing core fallback icon -> short text label.

import { setIcon } from 'obsidian';

// 'circle' has existed in the lucide set (and Obsidian) for a very long time,
// making it a safe cross-version fallback.
const FALLBACK_ICON_ID = 'circle';

function trySetIcon(el: HTMLElement, id: string): boolean {
  try {
    setIcon(el, id);
  } catch {
    return false;
  }
  return el.querySelector('svg') !== null;
}

export function setIconWithFallback(
  el: HTMLElement,
  iconId: string | undefined,
  fallbackText?: string
): void {
  const id = (iconId ?? '').trim();
  if (id && trySetIcon(el, id)) return;
  if (trySetIcon(el, FALLBACK_ICON_ID)) return;

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
