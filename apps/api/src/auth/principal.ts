import type { Channel, PrincipalKind, ToolName, UserRole } from "@qenbel/shared";

/**
 * The only source of tenant, role and permissions for a request. Built on the server from a verified
 * session or API credential; never from the request body, query, path or headers.
 */
export interface Principal {
  readonly kind: PrincipalKind;
  /** Null only for a platform admin who is not a member of any tenant. */
  readonly tenantId: string | null;
  readonly userId: string | null;
  readonly credentialId: string | null;
  /** External identity (Clerk user id or dev identity). Null for API credentials. */
  readonly subject: string | null;
  readonly displayName: string | null;
  readonly role: UserRole | null;
  readonly permissions: readonly string[];
  /** Tool allow-list of an API credential. Empty for users. */
  readonly allowedTools: readonly ToolName[];
  readonly channel: Channel;
  readonly isPlatformAdmin: boolean;
}

export function principalId(p: Principal): string {
  return p.userId ?? p.credentialId ?? p.subject ?? "unknown";
}

export function hasPermission(p: Principal, permission: string): boolean {
  return p.permissions.includes(permission);
}
