// ============================================================
// Modal — every dialog in the app. Rendered at the top of the page (a
// portal), so no panel or bar can paint over it; a close button in its
// title bar; Esc and the phone's Back button close it. On a phone it fills
// the screen, its body scrolls and its buttons stay at the bottom.
// ============================================================
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useBackLayer } from '../lib/backStack.js';

/**
 * @param {{ title: string, onClose: () => void, className?: string, width?: number,
 *           children: any, closeOnBackdrop?: boolean }} p
 */
export default function Modal({ title, onClose, className = '', width, children, closeOnBackdrop = true }) {
  useBackLayer(true, onClose);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  return createPortal(
    <div className="modal-bg" onClick={closeOnBackdrop ? onClose : undefined}>
      <div className={'modal' + (className ? ' ' + className : '')} style={width ? { maxWidth: width } : undefined}
        role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-x" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
