import { Children, cloneElement, useRef } from 'react';
import { createPortal } from 'react-dom';
import useModalLifecycle from '../hooks/useModalLifecycle';

// Preserve existing headers/forms while giving legacy dialogs the same lifecycle.
export default function ModalLayer({ children, className, label, onClick, onClose = onClick, closeDisabled = false }) {
  const dialogRef = useRef(null);
  useModalLifecycle(dialogRef, { onClose, closeDisabled });
  const panel = Children.only(children);
  return createPortal(
    <div data-modal-layer className={className} onClick={closeDisabled ? undefined : onClick}>
      {cloneElement(panel, {
        ref: dialogRef, role: 'dialog', 'aria-modal': true, 'aria-label': label, tabIndex: -1,
        className: `${panel.props.className || ''} outline-none`,
        onClick: event => { event.stopPropagation(); panel.props.onClick?.(event); },
        style: { ...panel.props.style, maxHeight: 'calc(100dvh - 2rem)', overflowY: 'auto', overscrollBehavior: 'contain' },
      })}
    </div>, document.body,
  );
}
