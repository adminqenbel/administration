import { useState } from "react";
import { Button, Dialog, EmptyState, Input, PageHeader, Select, Table, Tabs, useToast } from "@qenbel/ui";
import type { Column } from "@qenbel/ui";
import { useBusiness } from "../business.tsx";
import { BOOKING_STATUSES, BOOKING_TONES } from "../status.ts";
import { copy } from "../terminology.ts";
import { usePageTitle } from "../usePageTitle.ts";
import { NotConnected, StatusKey } from "./parts.tsx";

interface Row {
  id: string;
}

export function Bookings() {
  const { terminology: t } = useBusiness();
  const c = copy(t);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  usePageTitle(t.bookings);

  const columns: Column<Row>[] = [
    { key: "time", header: "Time", numeric: true, render: () => null },
    { key: "customer", header: t.customer, render: () => null },
    { key: "item", header: t.catalogueItem, render: () => null },
    { key: "resource", header: t.resource, render: () => null },
    { key: "status", header: "Status", render: () => null },
  ];

  const table = (caption: string) => (
    <Table<Row> caption={caption} columns={columns} rows={[]} rowKey={(r) => r.id} empty={<EmptyState title={c.emptyTitle(t.bookings)} text={c.emptyText(t.bookings)} />} />
  );

  return (
    <>
      <PageHeader
        title={t.bookings}
        description={`See and manage ${t.bookings.toLocaleLowerCase("en")}.`}
        actions={<Button onClick={() => setOpen(true)}>{c.newBooking}</Button>}
      />
      <Tabs
        label={t.bookings}
        tabs={[
          { id: "upcoming", label: "Upcoming", panel: table(`Upcoming ${t.bookings.toLocaleLowerCase("en")}`) },
          { id: "past", label: "Past", panel: table(`Past ${t.bookings.toLocaleLowerCase("en")}`) },
          { id: "cancelled", label: "Cancelled", panel: table(`Cancelled ${t.bookings.toLocaleLowerCase("en")}`) },
        ]}
      />
      <StatusKey title="Statuses" statuses={BOOKING_STATUSES} tones={BOOKING_TONES} overrides={t.bookingStatusLabels} />
      <div className="stack">
        <NotConnected />
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={c.newBooking}
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
        <Input label={t.customer} name="customer" autoComplete="off" />
        <Select label={t.catalogueItem} name="item" defaultValue="">
          <option value="" disabled>
            Choose one
          </option>
        </Select>
        <Input label="Date and time" name="when" type="datetime-local" />
      </Dialog>
    </>
  );
}
