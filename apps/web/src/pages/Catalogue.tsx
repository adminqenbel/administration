import { useState } from "react";
import { Button, Dialog, EmptyState, Input, PageHeader, Table, Textarea, useToast } from "@qenbel/ui";
import type { Column } from "@qenbel/ui";
import { useBusiness } from "../business.tsx";
import { copy } from "../terminology.ts";
import { usePageTitle } from "../usePageTitle.ts";
import { NotConnected } from "./parts.tsx";

interface Row {
  id: string;
}

export function Catalogue() {
  const { terminology: t, modules } = useBusiness();
  const c = copy(t);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  usePageTitle(t.catalogue);

  const columns: Column<Row>[] = [
    { key: "name", header: "Name", render: () => null },
    { key: "duration", header: "Minutes", numeric: true, render: () => null },
    { key: "price", header: "Price", numeric: true, render: () => null },
    { key: "active", header: "Active", render: () => null },
  ];

  return (
    <>
      <PageHeader title={t.catalogue} description={`What you offer. ${modules.orders ? `${t.bookings} and ${t.ordersNoun.toLocaleLowerCase("en")}` : t.bookings} pick from this list.`} actions={<Button onClick={() => setOpen(true)}>{c.newItem}</Button>} />
      <Table<Row> caption={t.catalogue} columns={columns} rows={[]} rowKey={(r) => r.id} empty={<EmptyState title={c.emptyTitle(t.catalogue)} text={c.emptyText(t.catalogue)} />} />
      <div className="stack">
        <NotConnected />
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={c.newItem}
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setOpen(false);
                toast({ message: "Saving is not connected yet.", tone: "info" });
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <Input label="Name" name="name" autoComplete="off" required />
        <Textarea label="Description" name="description" hint="Plain text only." />
        <Input label="Minutes" name="minutes" type="number" inputMode="numeric" min={0} />
      </Dialog>
    </>
  );
}
