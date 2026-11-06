import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: string;
  description?: string;
  eyebrow?: string;
  /** Buttons for the right side. */
  actions?: ReactNode;
}

export function PageHeader({ title, description, eyebrow, actions }: PageHeaderProps) {
  return (
    <header className="qb-pageheader">
      <div className="qb-pageheader__text">
        {eyebrow ? <p className="qb-pageheader__eyebrow">{eyebrow}</p> : null}
        <h1 className="qb-pageheader__title">{title}</h1>
        {description ? <p className="qb-pageheader__desc">{description}</p> : null}
      </div>
      {actions ? <div className="qb-actions">{actions}</div> : null}
    </header>
  );
}
