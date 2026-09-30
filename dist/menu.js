/**
 * The one context menu in the app.
 *
 * Both the process table and the compact widget's view picker use it, so they open
 * the same way, dismiss the same way, and cannot drift apart. Items are
 * `{ label, icon, checked, danger, run }` or `{ separator: true }`.
 */

import { escapeHtml } from "./views.js";

let dismiss = null;

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

/**
 * @param {{items: Array, heading?: string, x?: number, y?: number, anchor?: Element}} options
 */
export function openMenu({ items, heading, x, y, anchor, onClose }) {
  const menu = document.getElementById("ctx");
  if (!menu || !items?.length) return;

  menu.innerHTML =
    (heading ? `<div class="head">${escapeHtml(heading)}</div>` : "") +
    items
      .map((item, index) =>
        item.separator
          ? '<div class="sep"></div>'
          : `<button type="button" class="${item.danger ? "is-danger" : ""}" data-i="${index}"${
              item.checked ? ' aria-checked="true"' : ""
            }><svg><use href="#i-${item.icon || "activity"}"/></svg><span>${escapeHtml(item.label)}</span></button>`,
      )
      .join("");

  menu.hidden = false;

  // Positioned after unhiding: a hidden element measures zero, which would pin every
  // anchored menu to its button's right edge and push it off screen.
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    x = rect.right - menu.offsetWidth;
    y = rect.bottom + 6;
  }
  // Clamp inside the viewport: a menu that opens off-screen is a menu nobody uses.
  menu.style.left = `${clamp(x ?? 0, 8, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${clamp(y ?? 0, 8, window.innerHeight - menu.offsetHeight - 8)}px`;

  const stop = () => {
    menu.hidden = true;
    menu.onclick = null;
    dismiss = null;
    onClose?.();
  };

  menu.onclick = (event) => {
    const button = event.target.closest("[data-i]");
    if (!button) return;
    const item = items[Number(button.dataset.i)];
    stop();
    item?.run?.();
  };

  // A click anywhere else, or Escape, closes the menu. Registered per opening and
  // torn down on close so nothing is left listening.
  dismiss = (event) => {
    if (event.type === "keydown" && event.key !== "Escape") return;
    if (event.type === "click" && event.target.closest("#ctx")) return;
    stop();
  };
  document.addEventListener("click", dismiss, true);
  document.addEventListener("keydown", dismiss, true);
  menu.dataset.open = "true";
  return { close: stop };
}

export function closeMenu() {
  dismiss?.(new KeyboardEvent("keydown", { key: "NotEscape" }));
}
