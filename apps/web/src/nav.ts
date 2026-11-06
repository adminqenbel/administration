import type { NavItem } from "@qenbel/ui";
import type { Terminology } from "./terminology.ts";

export interface Modules {
  bookings: boolean;
  orders: boolean;
}

export const ALL_MODULES: Modules = { bookings: true, orders: true };

/**
 * The navigation, driven by terminology (labels) and by which modules the pack uses.
 * Routes are fixed; only the words and the presence of bookings or orders change.
 * This only shapes the menu. Access is decided by the server on every request.
 */
export function buildNav(t: Terminology, modules: Modules = ALL_MODULES): NavItem[] {
  const items: Array<NavItem | null> = [
    { to: "/", label: t.dashboard, icon: "home", end: true },
    modules.bookings ? { to: "/bookings", label: t.bookings, icon: "calendar" } : null,
    modules.orders ? { to: "/orders", label: t.orders, icon: "bag" } : null,
    { to: "/customers", label: t.customers, icon: "users" },
    { to: "/catalogue", label: t.catalogue, icon: "tag" },
    { to: "/resources", label: t.resources, icon: "layers" },
    { to: "/settings", label: t.settings, icon: "settings" },
  ];
  return items.filter((i): i is NavItem => i !== null);
}
