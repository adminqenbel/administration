import type { ReactNode } from "react";

export type IconName = "home" | "calendar" | "bag" | "users" | "tag" | "layers" | "settings" | "more";

// Simple outline paths on a 24px grid. Flat, stroke only.
const paths: Record<IconName, ReactNode> = {
  home: <path d="M4 11.5 12 4l8 7.5M6 10v10h12V10M10 20v-6h4v6" />,
  calendar: <path d="M5 5h14v15H5zM5 10h14M9 3v4M15 3v4" />,
  bag: <path d="M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2" />,
  users: <path d="M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14.3c1.8.8 3 2.6 3 4.7" />,
  tag: <path d="M4 4h8l8 8-8 8-8-8zM8.5 8.5h.01" />,
  layers: <path d="m12 4 8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4" />,
  settings: <path d="M4 7h10M18 7h2M4 17h2M10 17h10M16 4v6M8 14v6" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="qb-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  );
}
