/**
 * Theme control.
 *
 * Three states, one button: the app starts on whatever the operating system is
 * doing (`system`), and each press moves it one step along system -> light -> dark.
 * `resolve()` is exported separately so the pure part can be tested without a browser.
 */

export const THEMES = ["system", "light", "dark"];

/** The next theme in the cycle. Pure, so the unit tests can walk it. */
export function nextTheme(current) {
  const index = THEMES.indexOf(current);
  return THEMES[(index + 1) % THEMES.length];
}

/** The theme the operating system is asking for. */
export function systemTheme() {
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark"
    : "dark";
}

export function resolve(preference) {
  return preference === "system" ? systemTheme() : preference;
}

/** Sentence for the tooltip, so the button explains itself on hover. */
export function describe(preference) {
  if (preference === "system") {
    return `Theme: system (${systemTheme()}) - click for light`;
  }
  return `Theme: ${preference} - click for ${nextTheme(preference)}`;
}

const STORAGE_KEY = "tasma.theme";

export function createTheme({ root = document.documentElement, onChange } = {}) {
  const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
  let preference = "system";

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (THEMES.includes(stored)) preference = stored;
  } catch {
    // A locked-down profile just gets the default.
  }

  function apply() {
    const resolved = resolve(preference);
    root.dataset.theme = resolved;
    root.dataset.themePreference = preference;
    onChange?.(resolved, preference);
  }

  apply();

  // Only follow the system while the user has not chosen for themselves.
  media?.addEventListener?.("change", () => {
    if (preference === "system") apply();
  });

  return {
    apply,
    cycle() {
      preference = nextTheme(preference);
      try {
        localStorage.setItem(STORAGE_KEY, preference);
      } catch {
        // Not being able to remember it is not a reason to fail.
      }
      apply();
      return preference;
    },
    get preference() {
      return preference;
    },
    get resolved() {
      return resolve(preference);
    },
  };
}
