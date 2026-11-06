import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cx } from "../cx.ts";

export type ToastTone = "info" | "success" | "error";

export interface ToastInput {
  message: string;
  tone?: ToastTone;
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastApi {
  toast: (input: ToastInput | string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside ToastProvider");
  return api;
}

export interface ToastProviderProps {
  children: ReactNode;
  /** Milliseconds before a toast goes away. */
  duration?: number;
  dismissLabel?: string;
}

export function ToastProvider({ children, duration = 6000, dismissLabel = "Dismiss" }: ToastProviderProps) {
  const [items, setItems] = useState<ReadonlyArray<ToastItem>>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);

  const toast = useCallback(
    (input: ToastInput | string) => {
      const id = next.current++;
      const item: ToastItem = typeof input === "string" ? { id, message: input } : { id, ...input };
      setItems((all) => [...all.slice(-3), item]);
      setTimeout(() => dismiss(id), duration);
    },
    [dismiss, duration],
  );

  const api = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="qb-toasts" role="region" aria-label="Notifications" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx("qb-toast", t.tone === "success" && "qb-toast--success", t.tone === "error" && "qb-toast--error")}>
            <span>{t.message}</span>
            <button type="button" className="qb-toast__close" aria-label={dismissLabel} onClick={() => dismiss(t.id)}>
              <span aria-hidden="true">&times;</span>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
