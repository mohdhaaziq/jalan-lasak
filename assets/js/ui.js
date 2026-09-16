/* Modal dialogs and toasts in the Modernist language, replacing the browser's
   prompt/confirm/alert — those cannot be themed and are blocked or styled
   inconsistently on mobile. Everything is built as DOM nodes with textContent,
   so user-entered names are never parsed as markup. */

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function openDialog({ title, body, input, actions }) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const backdrop = el('div', 'dialog-backdrop jl-backdrop');
    const dialog = el('div', 'dialog jl-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    const heading = el('div', 'dialog-title', title);
    heading.id = 'jl-dlg-title';
    dialog.setAttribute('aria-labelledby', heading.id);
    dialog.append(heading);

    if (body) dialog.append(el('div', 'dialog-body', body));

    let field = null;
    if (input) {
      field = el('input', 'input');
      field.type = 'text';
      field.value = input.value || '';
      field.placeholder = input.placeholder || '';
      field.setAttribute('aria-label', input.label || title);
      field.enterKeyHint = 'done';
      dialog.append(field);
    }

    const bar = el('div', 'dialog-actions');
    const close = (result) => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      if (previous && previous.focus) previous.focus();
      resolve(result);
    };

    actions.forEach((action) => {
      const button = el('button', 'jl-btn' + (action.accent ? ' acc' : ''), action.label);
      button.type = 'button';
      button.addEventListener('click', () => {
        close(action.value === 'INPUT' ? (field ? field.value.trim() : '') : action.value);
      });
      bar.append(button);
      action.node = button;
    });
    dialog.append(bar);

    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(null);
      } else if (event.key === 'Enter' && field && document.activeElement === field) {
        event.preventDefault();
        const primary = actions.find((a) => a.accent) || actions[0];
        primary.node.click();
      } else if (event.key === 'Tab') {
        // Keep focus inside the dialog.
        const focusable = dialog.querySelectorAll('input, button');
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);

    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close(null);
    });

    backdrop.append(dialog);
    document.body.append(backdrop);
    if (field) {
      field.focus();
      field.select();
    } else {
      (actions.find((a) => a.accent) || actions[0]).node.focus();
    }
  });
}

/** Ask for a line of text. Resolves to the trimmed string, or null if cancelled. */
export function askText({ title, body, value = '', placeholder = '', okLabel = 'Simpan', cancelLabel = 'Batal', label }) {
  return openDialog({
    title,
    body,
    input: { value, placeholder, label },
    actions: [
      { label: okLabel, value: 'INPUT', accent: true },
      { label: cancelLabel, value: null }
    ]
  });
}

/** Ask a yes/no question. Resolves to true only if confirmed. */
export async function askConfirm({ title, body, okLabel = 'Teruskan', cancelLabel = 'Batal' }) {
  const answer = await openDialog({
    title,
    body,
    actions: [
      { label: okLabel, value: true, accent: true },
      { label: cancelLabel, value: false }
    ]
  });
  return answer === true;
}

/** Tell the user something they must acknowledge. */
export function notify({ title, body, okLabel = 'OK' }) {
  return openDialog({ title, body, actions: [{ label: okLabel, value: true, accent: true }] });
}

let toastTimer = null;
/** A brief, non-blocking message at the foot of the screen. */
export function toast(message, ms = 3200) {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('on'), ms);
}
