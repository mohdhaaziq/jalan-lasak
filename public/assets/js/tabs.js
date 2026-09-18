/* Bottom tab bar: one pane at a time, so menu and content share a phone
   screen. Tapping the active tab closes the panel and gives the map the
   whole screen. The chosen tab is remembered per page. */

import { $ } from './core.js';

/**
 * Keep --app-h at the height the app must fill.
 *
 * As a home-screen app on iOS with a translucent status bar, WebKit slides
 * the document up under the status bar but does not make the viewport any
 * taller: innerHeight comes up short by the top and bottom insets, a blank
 * band is left under the page, and env(safe-area-inset-bottom) reads 0. So
 * in that mode the app is sized to the whole screen and the bottom inset is
 * worked out from what is missing (--sab), for the tab bar's padding.
 * Everywhere else the window height is the truth.
 */
function fitViewport() {
  const root = document.documentElement;
  let h = window.innerHeight;
  let sab = 0;
  if (navigator.standalone === true) {
    root.classList.add('ios-standalone');
    const portrait = window.innerHeight >= window.innerWidth;
    const full = portrait ? Math.max(screen.height, screen.width) : Math.min(screen.height, screen.width);
    const top = parseFloat(getComputedStyle(root).getPropertyValue('--sat')) || 0;
    if (full > h) {
      sab = Math.max(0, Math.min(60, full - h - top));
      h = full;
    }
  }
  root.style.setProperty('--app-h', h + 'px');
  root.style.setProperty('--sab', sab + 'px');
}

/** Size the app to the real screen now and on every change. For any page, with or without tabs. */
export function watchViewport(onChange) {
  const run = () => { fitViewport(); if (onChange) onChange(); };
  run();
  window.addEventListener('resize', run);
  window.addEventListener('orientationchange', () => setTimeout(run, 300));
  window.addEventListener('pageshow', run);
  setTimeout(run, 500);
}

export function mountTabs({ map, storageKey, defaultPane }) {
  watchViewport();

  const tabs = [...document.querySelectorAll('#tabbar [role="tab"]')];
  const sheet = $('sheet');
  if (!tabs.length || !sheet) return null;

  function show(name) {
    for (const tab of tabs) {
      const on = tab.dataset.pane === name;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on || (name === null && tab === tabs[0]) ? 0 : -1;
      const pane = $('pane-' + tab.dataset.pane);
      if (pane) pane.hidden = !on;
    }
    sheet.classList.toggle('open', name !== null);
    try { localStorage.setItem(storageKey, name || ''); } catch { /* storage unavailable */ }
    // The map's usable height changed with the panel.
    if (map) setTimeout(() => map.invalidateSize({ pan: false }), 210);
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const open = tab.getAttribute('aria-selected') === 'true';
      show(open ? null : tab.dataset.pane);
    });
    tab.addEventListener('keydown', (event) => {
      const i = tabs.indexOf(tab);
      let next = null;
      if (event.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
      if (event.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
      if (next) {
        event.preventDefault();
        next.focus();
        show(next.dataset.pane);
      }
    });
  }

  let saved = defaultPane;
  try { saved = localStorage.getItem(storageKey) ?? defaultPane; } catch { /* storage unavailable */ }
  show(saved === '' ? null : (tabs.some((t) => t.dataset.pane === saved) ? saved : defaultPane));
  return { show };
}
