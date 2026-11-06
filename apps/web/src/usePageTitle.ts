import { useEffect } from "react";

/** Sets the browser tab title: "Bookings - QenBel Administration". */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} - QenBel Administration`;
  }, [title]);
}
