const entries = [];
let restoreScroll;
let hiddenBranches = [];
const top = () => entries.at(-1);
// Closed <details> descendants can retain layout boxes in Chromium, although
// only their first <summary> (and its contents) remains available to keyboard users.
function disclosed(element) {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName !== 'DETAILS' || parent.open) continue;
    const summary = [...parent.children].find(child => child.tagName === 'SUMMARY');
    if (!summary?.contains(element)) return false;
  }
  return true;
}
const visible = element => element?.isConnected && !element.closest('[inert], [hidden]')
  && disclosed(element) && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
const focus = (element, preventScroll = true) => { if (visible(element)) element.focus({ preventScroll }); };
const focusables = element => [...element.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex], [contenteditable="true"]')]
  .filter(item => item.tabIndex >= 0 && !item.matches(':disabled') && visible(item));

function keydown(event) {
  const entry = top();
  if (!entry || event.defaultPrevented || event.isComposing) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    entry.onClose();
  } else if (event.key === 'Tab') {
    const items = focusables(entry.element);
    const index = items.indexOf(document.activeElement);
    if (!items.length || index < 0 || (event.shiftKey ? index === 0 : index === items.length - 1)) {
      event.preventDefault();
      focus(items.length ? (event.shiftKey ? items.at(-1) : items[0]) : entry.element, false);
    }
  }
}

function focusin(event) {
  const entry = top();
  if (entry && !entry.element.contains(event.target)) focus(entry.element);
}

function syncLayers() {
  for (const [element, inert] of hiddenBranches) element.inert = inert;
  hiddenBranches = [];
  entries.forEach((entry, index) => {
    entry.layer.style.zIndex = String(100 + index * 10);
    if (entry === top()) entry.element.setAttribute('aria-modal', 'true');
    else entry.element.setAttribute('aria-modal', 'false');
  });
  // Hide background and lower dialogs from pointer, keyboard and assistive tech,
  // without making an ancestor of the active dialog inert (nested DOM or portals).
  let branch = top()?.layer;
  while (branch?.parentElement) {
    for (const sibling of branch.parentElement.children) {
      if (sibling !== branch && !['SCRIPT', 'STYLE', 'LINK'].includes(sibling.tagName)) {
        hiddenBranches.push([sibling, sibling.inert]);
        sibling.inert = true;
      }
    }
    if (branch.parentElement === document.body) break;
    branch = branch.parentElement;
  }
}

export function registerModal(element, onClose) {
  if (!element) return () => {};
  if (!entries.length) {
    const body = document.body;
    const overflow = body.style.overflow;
    const padding = body.style.paddingRight;
    const gap = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
    if (gap) body.style.paddingRight = `${parseFloat(getComputedStyle(body).paddingRight) + gap}px`;
    body.style.overflow = 'hidden';
    restoreScroll = () => { body.style.overflow = overflow; body.style.paddingRight = padding; };
    document.addEventListener('keydown', keydown);
    document.addEventListener('focusin', focusin);
  }
  const layer = element.closest('[data-modal-layer]') || element;
  const entry = { element, layer, onClose, previousFocus: document.activeElement,
    zIndex: layer.style.zIndex, ariaModal: element.getAttribute('aria-modal') };
  const descendant = entries.findIndex(item => element.contains(item.element));
  if (descendant < 0) entries.push(entry);
  else entries.splice(descendant, 0, entry);
  syncLayers();
  if (entry === top()) focus(element);
  return () => {
    const index = entries.indexOf(entry);
    if (index < 0) return;
    const wasTop = entry === top();
    // If a parent disappears first, let its child restore to the original opener.
    for (const other of entries) {
      if (other !== entry && element.contains(other.previousFocus)) other.previousFocus = entry.previousFocus;
    }
    entries.splice(index, 1);
    layer.style.zIndex = entry.zIndex;
    if (entry.ariaModal === null) element.removeAttribute('aria-modal');
    else element.setAttribute('aria-modal', entry.ariaModal);
    syncLayers();
    if (!entries.length) {
      restoreScroll();
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('focusin', focusin);
    }
    if (wasTop) {
      const target = entry.previousFocus;
      if (visible(target) && (!top() || top().element.contains(target))) focus(target);
      else focus(top()?.element);
    }
  };
}
