// What the availability code needs to read, behind a small interface so the catalogue engine's loader
// can replace the private SQL reader later (pass it as EngineOptions.availability).
import type { AllocationMode, EngineContext, ResourceType, SqlClient, TimeRange } from "@qenbel/shared";

export interface ResourceSummary {
  id: string;
  name: string;
  type: ResourceType;
  /** Resolved location (the resource's own, else the tenant's default location). Null if the tenant has none. */
  locationId: string | null;
  /** IANA zone of that location, else the tenant default. Availability is computed in this zone. */
  timezone: string;
  allocationMode: AllocationMode;
  capacityUnits: number;
  minUnits: number;
}

export type IneligibleReason = "type" | "service" | "party_size";

export interface ResourceCandidate extends ResourceSummary {
  eligible: boolean;
  reason?: IneligibleReason;
}

export interface CandidateQuery {
  /** Specific resources. When set, every existing active one is returned with an `eligible` flag. */
  resourceIds?: readonly string[];
  /** The service the customer wants. A resource that lists services must list this one. */
  catalogueItemId?: string | null;
  /** The service needs this resource type. */
  requiredType?: ResourceType | null;
  /** Types the config pack allows. */
  allowedTypes: readonly ResourceType[];
  partySize?: number | null;
  fallbackTimezone: string;
}

/** Weekday 0 = Sunday ... 6 = Saturday, times "HH:MM". */
export interface HourRow {
  weekday: number;
  start: string;
  end: string;
}

export interface ScheduleRow extends HourRow {
  validFrom: string | null;
  validTo: string | null;
}

/** A recurring break on one weekday (0 = Sunday ... 6 = Saturday), local time "HH:MM". */
export type BreakRow = HourRow;

export interface HolidayRow {
  /** Local date YYYY-MM-DD. */
  date: string;
  closed: boolean;
  open: string | null;
  close: string | null;
}

/** An active, unexpired allocation as stored (for an exclusive resource it includes the trailing buffer). No customer data. */
export interface AllocationRow {
  start: string;
  end: string;
  units: number;
}

export interface ResourceAvailabilityInputs {
  resource: ResourceSummary;
  /** Location opening hours. Empty means "not configured": the pack defaults apply. */
  businessHours: HourRow[];
  /** The resource's own weekly pattern. Empty means "follows the location". */
  resourceHours: ScheduleRow[];
  holidays: HolidayRow[];
  /** The resource's own weekly breaks (resource_breaks), or null when it has none (tenant/pack breaks apply). */
  breaks: BreakRow[] | null;
  timeOff: TimeRange[];
  allocations: AllocationRow[];
  /** True when stored data for this resource could not be understood. The resource is then treated as unavailable. */
  unreadable: boolean;
}

export interface InputsWindow {
  /** Instants that cover every requested local date in every zone, with margin. */
  from: Date;
  to: Date;
  /** First and last local date requested. */
  fromDate: string;
  toDate: string;
}

export interface AvailabilityDataSource {
  listResources(sql: SqlClient, ctx: EngineContext, query: CandidateQuery): Promise<ResourceCandidate[]>;
  loadInputs(
    sql: SqlClient,
    ctx: EngineContext,
    resources: readonly ResourceSummary[],
    window: InputsWindow,
  ): Promise<ResourceAvailabilityInputs[]>;
}
