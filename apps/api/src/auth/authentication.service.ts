// Turns a bearer token into a Principal. The tenant, role and permissions come from the database row that
// belongs to the verified identity (or API credential), never from the request.
//
//   token "qbk_..."  -> API credential: auth_lookup_credential, peppered HMAC, constant-time compare
//   anything else    -> AuthProvider (dev | clerk) -> auth_lookup_user / auth_is_platform_admin
//
// Client-visible outcomes are deliberately few: 401 for a token that does not verify or a credential that
// does not work (all causes look the same), 403 for a verified person with no active membership (unknown,
// deactivated, suspended tenant and wrong-deployment all look the same). The reason goes to the log.
import { Inject, Injectable } from "@nestjs/common";
import { AppError, Channel, DeploymentMode, ErrorCode, PrincipalKind, type ToolName, isUserRole } from "@qenbel/shared";
import type { Pool } from "@qenbel/db";
import { toolNames } from "../authz/tool-names.ts";
import { permissionsForCredential, permissionsForUserRole } from "../authz/permissions.ts";
import { AUTH_PROVIDER, CLOCK, CONFIG, DB_POOL, LOGGER } from "../common/tokens.ts";
import { AppLogger } from "../common/logger.ts";
import type { AppConfig } from "../config/config.ts";
import { type AuthProvider, AuthError, MAX_TOKEN_LENGTH } from "./auth-provider.ts";
import { looksLikeApiKey, parseApiKey, verifyApiKeySecret } from "./api-key.ts";
import type { Principal } from "./principal.ts";

interface CredentialRow {
  credential_id: string;
  tenant_id: string;
  credential_type: string;
  secret_hash: string | null;
  pepper_version: number;
  tool_scopes: string[];
  allowed_origins: string[];
  expires_at: Date | null;
  revoked_at: Date | null;
}

interface UserRow {
  user_id: string;
  tenant_id: string;
  role: string;
  display_name: string;
}

/** Why authentication failed, for the server log. Never sent to the client. */
export class AuthFailure extends AppError {
  readonly reason: string;
  constructor(code: typeof ErrorCode.UNAUTHENTICATED | typeof ErrorCode.FORBIDDEN, reason: string) {
    super(code);
    this.reason = reason;
  }
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer ([^\s]+)$/i.exec(header.trim());
  if (!m) return null;
  const token = m[1] as string;
  return token.length <= MAX_TOKEN_LENGTH ? token : null;
}

@Injectable()
export class AuthenticationService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(AUTH_PROVIDER) private readonly provider: AuthProvider,
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Inject(CLOCK) private readonly now: () => Date,
  ) {}

  async authenticate(authorizationHeader: string | undefined, remoteAddress: string | undefined): Promise<Principal> {
    const token = bearerToken(authorizationHeader);
    if (token === null) throw new AuthFailure(ErrorCode.UNAUTHENTICATED, "missing_or_malformed_authorization");
    const principal = looksLikeApiKey(token)
      ? await this.fromApiKey(token)
      : await this.fromSession(token, remoteAddress);
    return this.enforceDeployment(principal);
  }

  private async fromSession(token: string, remoteAddress: string | undefined): Promise<Principal> {
    let identity;
    try {
      identity = await this.provider.authenticate({ token, remoteAddress });
    } catch (err) {
      if (err instanceof AuthError) throw new AuthFailure(ErrorCode.UNAUTHENTICATED, err.reason);
      throw err;
    }
    const [users, adminRes] = await Promise.all([
      this.pool.query<UserRow>("select user_id, tenant_id, role, display_name from auth_lookup_user($1, $2)", [
      identity.provider,
      identity.subject,
    ]),
      this.pool.query<{ is_admin: boolean }>("select auth_is_platform_admin($1, $2) as is_admin", [
      identity.provider,
      identity.subject,
    ]),
    ]);
    const isPlatformAdmin = adminRes.rows[0]?.is_admin === true;
    const user = users.rows[0];

    if (user) {
      if (!isUserRole(user.role)) throw new AuthFailure(ErrorCode.FORBIDDEN, "unknown_role");
      return {
        kind: PrincipalKind.USER,
        tenantId: user.tenant_id,
        userId: user.user_id,
        credentialId: null,
        subject: identity.subject,
        displayName: user.display_name,
        role: user.role,
        permissions: permissionsForUserRole(user.role),
        allowedTools: [],
        channel: Channel.DASHBOARD,
        isPlatformAdmin,
      };
    }
    if (isPlatformAdmin) {
      return {
        kind: PrincipalKind.PLATFORM_ADMIN,
        tenantId: null,
        userId: null,
        credentialId: null,
        subject: identity.subject,
        displayName: null,
        role: null,
        permissions: [],
        allowedTools: [],
        channel: Channel.DASHBOARD,
        isPlatformAdmin: true,
      };
    }
    // Unknown or deactivated person, or their tenant is suspended: all look the same.
    throw new AuthFailure(ErrorCode.FORBIDDEN, "no_active_membership");
  }

  private async fromApiKey(token: string): Promise<Principal> {
    const parsed = parseApiKey(token);
    if (!parsed) {
      // Same work as a real check, so the shape of a bad key does not show in the response time.
      verifyApiKeySecret({ pepper: this.config.apiKeyPepper, lookupId: "qbk_000000000000", secret: "x".repeat(43), storedHash: null });
      throw new AuthFailure(ErrorCode.UNAUTHENTICATED, "credential_malformed");
    }
    const res = await this.pool.query<CredentialRow>("select * from auth_lookup_credential($1)", [parsed.lookupId]);
    const row = res.rows[0];
    const secretOk = verifyApiKeySecret({
      pepper: this.config.apiKeyPepper,
      lookupId: parsed.lookupId,
      secret: parsed.secret,
      storedHash: row?.secret_hash ?? null,
    });
    if (!row || !secretOk) throw new AuthFailure(ErrorCode.UNAUTHENTICATED, row ? "credential_secret_mismatch" : "credential_unknown");
    if (row.credential_type !== "api_key") throw new AuthFailure(ErrorCode.UNAUTHENTICATED, "credential_wrong_type");
    if (row.revoked_at !== null) throw new AuthFailure(ErrorCode.UNAUTHENTICATED, "credential_revoked");
    if (row.expires_at !== null && row.expires_at.getTime() <= this.now().getTime()) {
      throw new AuthFailure(ErrorCode.UNAUTHENTICATED, "credential_expired");
    }
    if (row.pepper_version !== this.config.apiKeyPepperVersion) {
      throw new AuthFailure(ErrorCode.UNAUTHENTICATED, "credential_pepper_version");
    }
    const tools = toolNames(row.tool_scopes);
    return {
      kind: PrincipalKind.API_CREDENTIAL,
      tenantId: row.tenant_id,
      userId: null,
      credentialId: row.credential_id,
      subject: null,
      displayName: null,
      role: null,
      permissions: permissionsForCredential(tools),
      allowedTools: tools as readonly ToolName[],
      channel: Channel.API,
      isPlatformAdmin: false,
    };
  }

  /** Isolated deployments serve exactly one tenant, named in configuration. Anything else is refused. */
  private enforceDeployment(p: Principal): Principal {
    if (this.config.deploymentMode !== DeploymentMode.ISOLATED) return p;
    if (p.tenantId === null) return p;
    if (p.tenantId !== this.config.isolatedTenantId) {
      this.logger.warn("principal belongs to another tenant than this isolated deployment", { principalKind: p.kind });
      throw new AuthFailure(p.kind === PrincipalKind.API_CREDENTIAL ? ErrorCode.UNAUTHENTICATED : ErrorCode.FORBIDDEN, "wrong_deployment_tenant");
    }
    return p;
  }
}
