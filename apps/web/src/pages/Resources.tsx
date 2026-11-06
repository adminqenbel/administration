import { Button, EmptyState, PageHeader, Table, useToast } from "@qenbel/ui";
import type { Column } from "@qenbel/ui";
import { useBusiness } from "../business.tsx";
import { copy } from "../terminology.ts";
import { usePageTitle } from "../usePageTitle.ts";
import { NotConnected } from "./parts.tsx";

interface Row {
  id: string;
}

export function Resources() {
  const { terminology: t } = useBusiness();
  const c = copy(t);
  const { toast } = useToast();
  usePageTitle(t.resources);

  const columns: Column<Row>[] = [
    { key: "name", header: "Name", render: () => null },
    { key: "type", header: "Type", render: () => null },
    { key: "capacity", header: "Capacity", numeric: true, render: () => null },
    { key: "active", header: "Active", render: () => null },
  ];

  return (
    <>
      <PageHeader
        title={t.resources}
        description={`The people and places that can be booked.`}
        actions={<Button onClick={() => toast({ message: "Saving is not connected yet.", tone: "info" })}>{c.newResource}</Button>}
      />
      <Table<Row> caption={t.resources} columns={columns} rows={[]} rowKey={(r) => r.id} empty={<EmptyState title={c.emptyTitle(t.resources)} text={c.emptyText(t.resources)} />} />
      <div className="stack">
        <NotConnected />
      </div>
    </>
  );
}
