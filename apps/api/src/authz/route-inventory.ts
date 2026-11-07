// Lists every HTTP route the application serves with its declared access policy. Used by the route-permission
// test (and available to Stage 3's tests): a route whose policy is undefined must fail the build.
import type { INestApplication } from "@nestjs/common";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants.js";
import { DiscoveryService, Reflector } from "@nestjs/core";
import { ACCESS_KEY, ALLOW_CREDENTIAL_KEY, type AccessPolicy } from "./decorators.ts";
import { IDEMPOTENT_KEY } from "../idempotency/idempotency.interceptor.ts";

const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "ALL", "OPTIONS", "HEAD", "SEARCH"] as const;

export interface RouteInfo {
  method: string;
  /** Full path as served, with prefix, for example "/v1/business/profile". Parameters as ":id". */
  path: string;
  controller: string;
  handler: string;
  policy: AccessPolicy | undefined;
  allowsApiCredential: boolean;
  idempotent: boolean;
}

function joinPath(...parts: string[]): string {
  const joined = parts
    .flatMap((p) => p.split("/"))
    .filter((s) => s.length > 0)
    .join("/");
  return `/${joined}`;
}

export function listRoutes(app: INestApplication, prefix: string, unprefixed: readonly string[]): RouteInfo[] {
  const discovery = app.get(DiscoveryService);
  const reflector = app.get(Reflector);
  const routes: RouteInfo[] = [];
  for (const wrapper of discovery.getControllers()) {
    const metatype = wrapper.metatype as (new (...a: never[]) => unknown) | null;
    if (!metatype) continue;
    const basePath = Reflect.getMetadata(PATH_METADATA, metatype) as string | string[] | undefined;
    const bases = Array.isArray(basePath) ? basePath : [basePath ?? "/"];
    for (const name of Object.getOwnPropertyNames(metatype.prototype)) {
      if (name === "constructor") continue;
      const handler = (metatype.prototype as Record<string, unknown>)[name];
      if (typeof handler !== "function") continue;
      const methodIndex = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (methodIndex === undefined) continue;
      const routePath = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
      const paths = Array.isArray(routePath) ? routePath : [routePath ?? "/"];
      for (const base of bases) {
        for (const p of paths) {
          const own = joinPath(base, p);
          const full = unprefixed.some((u) => joinPath(u) === own) ? own : joinPath(prefix, own);
          routes.push({
            method: METHODS[methodIndex] ?? String(methodIndex),
            path: full,
            controller: metatype.name,
            handler: name,
            policy: reflector.getAllAndOverride<AccessPolicy | undefined>(ACCESS_KEY, [handler as never, metatype]),
            allowsApiCredential: reflector.getAllAndOverride<boolean | undefined>(ALLOW_CREDENTIAL_KEY, [handler as never, metatype]) === true,
            idempotent: reflector.getAllAndOverride<boolean | undefined>(IDEMPOTENT_KEY, [handler as never, metatype]) === true,
          });
        }
      }
    }
  }
  return routes.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
}
