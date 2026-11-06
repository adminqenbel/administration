import { useState } from "react";
import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { Dialog } from "./Dialog.tsx";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./Icon.tsx";
import { Logo } from "./Logo.tsx";

export interface NavItem {
  to: string;
  label: string;
  icon?: IconName;
  /** Match the path exactly (use for the home route). */
  end?: boolean;
}

export interface AppShellProps {
  /** Navigation, in order. Labels come from the active terminology. */
  nav: ReadonlyArray<NavItem>;
  children: ReactNode;
  productSuffix?: string;
  /** Right side of the top bar: business name, sign out. */
  topBarEnd?: ReactNode;
  /** How many items sit in the phone bottom bar before the rest go under "More". Default 4. */
  bottomBarCount?: number;
  labels?: { skip?: string; side?: string; bottom?: string; more?: string; moreTitle?: string };
}

export function AppShell({ nav, children, productSuffix = "Administration", topBarEnd, bottomBarCount = 4, labels }: AppShellProps) {
  const l = { skip: "Skip to content", side: "Main menu", bottom: "Main menu", more: "More", moreTitle: "More", ...labels };
  const [moreOpen, setMoreOpen] = useState(false);
  const fits = nav.length <= bottomBarCount + 1;
  const bar = fits ? nav : nav.slice(0, bottomBarCount);
  const rest = fits ? [] : nav.slice(bottomBarCount);

  return (
    <div className="qb-shell">
      <a className="qb-skip" href="#main">
        {l.skip}
      </a>
      <header className="qb-topbar">
        <Link to="/" className="qb-topbar__brand" aria-label="QenBel Administration">
          <Logo suffix={productSuffix} />
        </Link>
        <div className="qb-topbar__end">{topBarEnd}</div>
      </header>

      <nav className="qb-sidenav" aria-label={l.side}>
        <ul className="qb-sidenav__list">
          {nav.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} end={item.end} className="qb-navlink">
                {item.icon ? <Icon name={item.icon} /> : null}
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <main className="qb-main" id="main" tabIndex={-1}>
        <div className="qb-main__inner">{children}</div>
      </main>

      <nav className="qb-bottombar" aria-label={l.bottom}>
        {bar.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className="qb-bottombar__item">
            {item.icon ? <Icon name={item.icon} /> : null}
            <span>{item.label}</span>
          </NavLink>
        ))}
        {rest.length > 0 ? (
          <button type="button" className="qb-bottombar__item" onClick={() => setMoreOpen(true)} aria-haspopup="dialog">
            <Icon name="more" />
            <span>{l.more}</span>
          </button>
        ) : null}
      </nav>

      <Dialog open={moreOpen} onClose={() => setMoreOpen(false)} title={l.moreTitle}>
        <ul className="qb-more">
          {rest.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} end={item.end} className="qb-navlink" onClick={() => setMoreOpen(false)}>
                {item.icon ? <Icon name={item.icon} /> : null}
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}
