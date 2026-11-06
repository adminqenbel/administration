import { Button, EmptyState, PageHeader, Table, Tabs, useToast } from "@qenbel/ui";
import type { Column } from "@qenbel/ui";
import { useBusiness } from "../business.tsx";
import { ORDER_STATUSES, ORDER_TONES } from "../status.ts";
import { copy, lower } from "../terminology.ts";
import { usePageTitle } from "../usePageTitle.ts";
import { NotConnected, StatusKey } from "./parts.tsx";

interface Row {
  id: string;
}

export function Orders() {
  const { terminology: t } = useBusiness();
  const c = copy(t);
  const { toast } = useToast();
  usePageTitle(t.orders);

  const columns: Column<Row>[] = [
    { key: "number", header: "Number", numeric: true, render: () => null },
    { key: "customer", header: t.customer, render: () => null },
    { key: "items", header: "Items", numeric: true, render: () => null },
    { key: "total", header: "Total", numeric: true, render: () => null },
    { key: "status", header: "Status", render: () => null },
  ];

  const table = (caption: string) => (
    <Table<Row> caption={caption} columns={columns} rows={[]} rowKey={(r) => r.id} empty={<EmptyState title={c.emptyTitle(t.ordersNoun)} text={c.emptyText(t.ordersNoun)} />} />
  );

  return (
    <>
      <PageHeader
        title={t.orders}
        description={`Follow each ${lower(t.order)} from placed to done.`}
        actions={<Button onClick={() => toast({ message: "Saving is not connected yet.", tone: "info" })}>{c.newOrder}</Button>}
      />
      <Tabs
        label={t.orders}
        tabs={[
          { id: "open", label: "Open", panel: table(`Open ${lower(t.ordersNoun)}`) },
          { id: "done", label: "Done", panel: table(`Done ${lower(t.ordersNoun)}`) },
          { id: "cancelled", label: "Cancelled", panel: table(`Cancelled ${lower(t.ordersNoun)}`) },
        ]}
      />
      <StatusKey title="Statuses" statuses={ORDER_STATUSES} tones={ORDER_TONES} overrides={t.orderStatusLabels} />
      <div className="stack">
        <NotConnected />
      </div>
    </>
  );
}
