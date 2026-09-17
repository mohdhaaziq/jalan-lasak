/* Bottom tab bar: one pane at a time, so menu and content share a phone
   screen. Tapping the active tab closes the panel and gives the map the
   whole screen. The chosen tab is remembered per page. */

import { $ } from './core.js';

/**
 * Keep --app-h at the window's real height. iOS standalone can report a
 * stale viewport at launch and only correct it on a later resize; following
 * the resize keeps the tab bar on the screen's bottom edge.
 */
function fitViewport() {
  document.documentElement.style.setProperty('--app-h', window.innerHeight + 'px');
}

export function mountTabs({ map, storageKey, defaultPane }) {
  fitViewport();
  window.addEventListener('resize', fitViewport);
  window.addEventListener('orientationchange', () => setTimeout(fitViewport, 300));
  window.addEventListener('pageshow', fitViewport);
  setTimeout(fitViewport, 500);

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
