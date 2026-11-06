import { Link } from "react-router-dom";
import { buttonClass, EmptyState } from "@qenbel/ui";
import { usePageTitle } from "../usePageTitle.ts";

export function NotFound() {
  usePageTitle("Page not found");
  return (
    <EmptyState
      title="Page not found"
      text="The address does not match a page here."
      action={
        <Link to="/" className={buttonClass("solid", "sm")}>
          Go to the dashboard
        </Link>
      }
    />
  );
}
