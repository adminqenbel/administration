// Permission strings (<module>:<action>) and the tenant role -> permission map.
import { UserRole } from "./enums.ts";

export const Permission = {
  BOOKINGS_READ: "bookings:read",
  BOOKINGS_WRITE: "bookings:write",
  ORDERS_READ: "orders:read",
  ORDERS_WRITE: "orders:write",
  CUSTOMERS_READ: "customers:read",
  CUSTOMERS_WRITE: "customers:write",
  CATALOGUE_READ: "catalogue:read",
  CATALOGUE_WRITE: "catalogue:write",
  RESOURCES_READ: "resources:read",
  RESOURCES_WRITE: "resources:write",
  BUSINESS_READ: "business:read",
  BUSINESS_WRITE: "business:write",
  INTEGRATIONS_MANAGE: "integrations:manage",
  USERS_MANAGE: "users:manage",
  AUDIT_READ: "audit:read",
  REPORTS_READ: "reports:read",
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS = Object.values(Permission) as readonly Permission[];

const P = Permission;

export const ROLE_PERMISSIONS: Readonly<Record<UserRole, readonly Permission[]>> = Object.freeze({
  // Everything, including business settings, integrations and team.
  [UserRole.OWNER]: Object.freeze([...ALL_PERMISSIONS]),
  // Runs day to day: bookings, orders, customers, catalogue, resources, reports, audit.
  // Cannot change business settings, integrations or team.
  [UserRole.MANAGER]: Object.freeze([
    P.BOOKINGS_READ,
    P.BOOKINGS_WRITE,
    P.ORDERS_READ,
    P.ORDERS_WRITE,
    P.CUSTOMERS_READ,
    P.CUSTOMERS_WRITE,
    P.CATALOGUE_READ,
    P.CATALOGUE_WRITE,
    P.RESOURCES_READ,
    P.RESOURCES_WRITE,
    P.BUSINESS_READ,
    P.AUDIT_READ,
    P.REPORTS_READ,
  ]),
  // Front desk: handles bookings, orders and customers. Read-only elsewhere.
  [UserRole.STAFF]: Object.freeze([
    P.BOOKINGS_READ,
    P.BOOKINGS_WRITE,
    P.ORDERS_READ,
    P.ORDERS_WRITE,
    P.CUSTOMERS_READ,
    P.CUSTOMERS_WRITE,
    P.CATALOGUE_READ,
    P.RESOURCES_READ,
    P.BUSINESS_READ,
  ]),
});

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (ALL_PERMISSIONS as readonly string[]).includes(value);
}

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, value);
}

/** Deny by default: unknown role or unknown permission returns false. */
export function hasPermission(role: unknown, permission: unknown): boolean {
  if (!isUserRole(role) || !isPermission(permission)) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsForRole(role: UserRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}
