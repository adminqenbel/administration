import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: string;
  text?: string;
  /** One or two buttons. */
  action?: ReactNode;
}

export function EmptyState({ title, text, action }: EmptyStateProps) {
  return (
    <div className="qb-empty">
      <p className="qb-empty__title">{title}</p>
      {text ? <p className="qb-empty__text">{text}</p> : null}
      {action ? <div className="qb-actions">{action}</div> : null}
    </div>
  );
}
