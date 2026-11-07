// The final permission list for the API.
//
// @qenbel/shared owns the tenant role -> permission map and the core permission strings. The API contract
// (docs/API-CONTRACT.md) and the tool registry use a few more (tasks, conversations, dashboard, payments,
// integrations:read, users:read, business:pack). Until those move into @qenbel/shared, they are declared here,
// and `API_ROLE_PERMISSIONS` is the shared map plus these extras. Where the contract's "proposed" matrix and
// @qenbel/shared disagree, @qenbel/shared wins (for example MANAGER has no business:write).
import { Permission as SharedPermission, ROLE_PERMISSIONS, type UserRole, UserRole as Roles, type ToolName } from "@qenbel/shared";
import { getTool } from "@qenbel/tool-registry";

export const ExtraPermission = {
  DASHBOARD_READ: "dashboard:read",
  TASKS_READ: "tasks:read",
  TASKS_WRITE: "tasks:write",
  CONVERSATIONS_READ: "conversations:read",
  CONVERSATIONS_WRITE: "conversations:write",
  PAYMENTS_READ: "payments:read",
  PAYMENTS_WRITE: "payments:write",
  INTEGRATIONS_READ: "integrations:read",
  USERS_READ: "users:read",
  BUSINESS_PACK: "business:pack",
} as const;

export const ApiPermission = { ...SharedPermission, ...ExtraPermission } as const;
export type ApiPermission = (typeof ApiPermission)[keyof typeof ApiPermission];

export const ALL_API_PERMISSIONS = Object.freeze(Object.values(ApiPermission)) as readonly ApiPermission[];

const X = ExtraPermission;

// Everyone who works in the business can see the dashboard and handle tasks and conversations.
const FRONT_DESK_EXTRAS: readonly ApiPermission[] = [
  X.DASHBOARD_READ,
  X.TASKS_READ,
  X.TASKS_WRITE,
  X.CONVERSATIONS_READ,
  X.CONVERSATIONS_WRITE,
];

export const API_ROLE_PERMISSIONS: Readonly<Record<UserRole, readonly ApiPermission[]>> = Object.freeze({
  [Roles.OWNER]: Object.freeze([...ALL_API_PERMISSIONS]),
  [Roles.MANAGER]: Object.freeze([
    ...(ROLE_PERMISSIONS[Roles.MANAGER] as readonly ApiPermission[]),
    ...FRONT_DESK_EXTRAS,
    X.PAYMENTS_READ,
    X.PAYMENTS_WRITE,
    X.INTEGRATIONS_READ,
    X.USERS_READ,
  ]),
  [Roles.STAFF]: Object.freeze([...(ROLE_PERMISSIONS[Roles.STAFF] as readonly ApiPermission[]), ...FRONT_DESK_EXTRAS]),
});

export function isApiPermission(value: unknown): value is ApiPermission {
  return typeof value === "string" && (ALL_API_PERMISSIONS as readonly string[]).includes(value);
}

export function permissionsForUserRole(role: UserRole): readonly ApiPermission[] {
  return API_ROLE_PERMISSIONS[role];
}

/**
 * Effective permissions of an API credential: the permission each allowed tool requires (from the tool
 * registry), nothing more. A credential has no role.
 */
export function permissionsForCredential(tools: readonly string[]): readonly ApiPermission[] {
  const out = new Set<ApiPermission>();
  for (const name of tools) {
    const tool = getTool(name);
    if (tool && isApiPermission(tool.requiredPermission)) out.add(tool.requiredPermission);
  }
  return [...out];
}

export type { ToolName };
