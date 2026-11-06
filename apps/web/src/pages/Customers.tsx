import { Button, EmptyState, Input, PageHeader, Table, useToast } from "@qenbel/ui";
import type { Column } from "@qenbel/ui";
import { useBusiness } from "../business.tsx";
import { copy, lower } from "../terminology.ts";
import { usePageTitle } from "../usePageTitle.ts";
import { NotConnected } from "./parts.tsx";

interface Row {
  id: string;
}

export function Customers() {
  const { terminology: t } = useBusiness();
  const c = copy(t);
  const { toast } = useToast();
  usePageTitle(t.customers);

  const columns: Column<Row>[] = [
    { key: "name", header: "Name", render: () => null },
    { key: "phone", header: "Phone", numeric: true, render: () => null },
    { key: "email", header: "Email", render: () => null },
    { key: "last", header: "Last visit", numeric: true, render: () => null },
  ];

  return (
    <>
      <PageHeader
        title={t.customers}
        description={`Everyone who has booked or ordered. Search by name, phone or email.`}
        actions={<Button onClick={() => toast({ message: "Saving is not connected yet.", tone: "info" })}>{c.newCustomer}</Button>}
      />
      <div className="toolbar">
        <Input label={`Search ${lower(t.customers)}`} type="search" name="q" autoComplete="off" placeholder="Name, phone or email" />
      </div>
      <Table<Row> caption={t.customers} columns={columns} rows={[]} rowKey={(r) => r.id} empty={<EmptyState title={c.emptyTitle(t.customers)} text={c.emptyText(t.customers)} />} />
      <div className="stack">
        <NotConnected />
      </div>
    </>
  );
}
