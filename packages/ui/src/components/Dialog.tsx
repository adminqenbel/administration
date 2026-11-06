import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { Button } from "./Button.tsx";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Buttons for the footer. */
  footer?: ReactNode;
  closeLabel?: string;
}

/** Modal built on the native dialog element: focus is trapped and Escape closes it. */
export function Dialog({ open, onClose, title, children, footer, closeLabel = "Close" }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="qb-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === ref.current) onClose();
      }}
    >
      {open ? (
        <>
          <div className="qb-dialog__head">
            <h2 className="qb-dialog__title" id={titleId}>
              {title}
            </h2>
            <Button variant="ghost" size="sm" onClick={onClose}>
              {closeLabel}
            </Button>
          </div>
          <div className="qb-dialog__body">{children}</div>
          {footer ? <div className="qb-dialog__foot">{footer}</div> : null}
        </>
      ) : null}
    </dialog>
  );
}
