// Global interceptor: wraps every handler of a principal that has a tenant in the request's tenant
// transaction (see UnitOfWork). Routes marked @Idempotent() open it themselves, after the idempotency claim,
// so a request never holds two database connections at once.
import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { from, lastValueFrom, type Observable } from "rxjs";
import { reqState } from "../common/request-state.ts";
import { IDEMPOTENT_KEY } from "../idempotency/idempotency.interceptor.ts";
import { UnitOfWork } from "./unit-of-work.service.ts";

@Injectable()
export class TenantUnitOfWorkInterceptor implements NestInterceptor {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    const principal = reqState(req).principal;
    if (!principal || principal.tenantId === null) return next.handle();
    if (this.reflector.getAllAndOverride<boolean | undefined>(IDEMPOTENT_KEY, [context.getHandler(), context.getClass()])) {
      return next.handle();
    }
    return from(this.uow.run(req, () => lastValueFrom(next.handle(), { defaultValue: undefined })));
  }
}
