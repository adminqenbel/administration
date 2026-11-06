import { EmptyState, PageHeader, Section, Stat, Stats, Table } from "@qenbel/ui";
import type { Column } from "@qenbel/ui";
import { useBusiness } from "../business.tsx";
import { copy, lower } from "../terminology.ts";
import { usePageTitle } from "../usePageTitle.ts";
import { NotConnected } from "./parts.tsx";

interface Row {
  id: string;
}

export function Dashboard() {
  const { terminology: t, modules } = useBusiness();
  const c = copy(t);
  usePageTitle(t.dashboard);

  const timeColumns: Column<Row>[] = [
    { key: "time", header: "Time", render: () => null, numeric: true },
    { key: "customer", header: t.customer, render: () => null },
    { key: "item", header: t.catalogueItem, render: () => null },
    { key: "resource", header: t.resource, render: () => null },
  ];

  return (
    <>
      <PageHeader title={t.dashboard} description="Today at a glance." />
      <Stats>
        {modules.bookings ? <Stat label={`${t.bookings} today`} value="0" /> : null}
        {modules.orders ? <Stat label={`Open ${lower(t.ordersNoun)}`} value="0" /> : null}
        <Stat label={`New ${lower(t.customers)} this week`} value="0" />
      </Stats>
      <div className="stack">
        {modules.bookings ? (
          <Section title={`Next ${lower(t.bookings)}`}>
            <Table<Row>
              caption={`Next ${lower(t.bookings)}`}
              columns={timeColumns}
              rows={[]}
              rowKey={(r) => r.id}
              empty={<EmptyState title={c.emptyTitle(t.bookings)} text={c.emptyText(t.bookings)} />}
            />
          </Section>
        ) : null}
        <NotConnected />
      </div>
    </>
  );
}
