/**
 * Light and dark are two readings of the same instrument: the dark theme is the
 * night-shift console, the light one is the paper the barograph actually draws
 * on. The tokens keep their names in both — `--ink` is always the surface and
 * `--bone` is always the mark, so nothing downstream has to know which is on.
 */

const KEY = "skyguard-theme";

export function storedTheme() {
  try {
    const t = localStorage.getItem(KEY);
    if (t === "light" || t === "dark") return t;
  } catch {
    // Private-mode or blocked storage: fall through to the default.
  }
  // Paper is the default: it is the palette the traces were designed around and
  // the one that survives a projector in a lit room.
  return "light";
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Not being able to remember the choice is not worth breaking the page for.
  }
}
