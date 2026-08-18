import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

export interface UseFocusTrapOptions {
  /** Whether the dialog/menu is currently open. */
  open: boolean;
  /** Called when Escape is pressed. Typically closes the surface. */
  onClose: () => void;
  /** Focused once, on open. Defaults to the container itself. */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export interface UseFocusTrapResult<T extends HTMLElement> {
  containerRef: RefObject<T | null>;
  onKeyDown: (event: KeyboardEvent) => void;
  /**
   * The element focused right before this surface opened. Exposed for the
   * rare case of an explicit hand-off to a second surface (e.g. a button
   * that closes this dialog and opens another): read it before calling
   * onClose so the second surface's own focus trap captures the same
   * original trigger, not whatever this one already refocused.
   */
  returnFocusRef: RefObject<HTMLElement | null>;
}

/**
 * Focus trap + Escape-to-close + return-focus-to-trigger, shared by every
 * modal dialog in the shell. Extracted from SettingsModal/
 * WorkspaceSwitcherDialog/CommandPalette/HelpCenter, which each hand-rolled
 * an identical implementation with drifting selectors.
 *
 * Return-focus runs from the effect's cleanup (fired whenever `open`
 * transitions to false, or the surface unmounts while open) rather than
 * from individual close call sites, so every way a dialog can close —
 * Escape, an explicit close button, a successful submit — restores focus
 * the same way without each call site needing to remember to.
 */
export function useFocusTrap<T extends HTMLElement>(
  options: UseFocusTrapOptions,
): UseFocusTrapResult<T> {
  const { open, initialFocusRef } = options;
  const containerRef = useRef<T | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(options.onClose);
  onCloseRef.current = options.onClose;

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const frame = window.requestAnimationFrame(() => {
      (initialFocusRef?.current ?? containerRef.current)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.requestAnimationFrame(() => returnFocusRef.current?.focus());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCloseRef.current();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>(
        FOCUSABLE_SELECTOR,
      ) ?? [],
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return { containerRef, onKeyDown, returnFocusRef };
}
