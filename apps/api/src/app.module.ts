import { type DynamicModule, Module, type Provider, type Type } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { BusinessController } from "./business/business.controller.ts";
import { CoreModule, type CoreDeps } from "./core.module.ts";
import { CredentialsController } from "./credentials/credentials.controller.ts";
import { CredentialsService } from "./credentials/credentials.service.ts";
import { HealthController } from "./health/health.controller.ts";
import { MeController } from "./me/me.controller.ts";
import { PlatformController } from "./platform/platform.controller.ts";
import { PlatformService } from "./platform/platform.service.ts";

export interface AppModuleOptions {
  deps: CoreDeps;
  /** Extra controllers and their providers (tests add routes this way; Stage 3 adds feature modules to `imports`). */
  extraControllers?: Type[];
  extraProviders?: Provider[];
}

/**
 * Module map: CoreModule (global cross-cutting services) + Health, Me, Business, Credentials and Platform.
 * Stage 3 adds its modules to `imports` here. Every controller must declare its access policy.
 */
@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [DiscoveryModule, CoreModule.forRoot(options.deps)],
      controllers: [HealthController, MeController, BusinessController, CredentialsController, PlatformController, ...(options.extraControllers ?? [])],
      providers: [CredentialsService, PlatformService, ...(options.extraProviders ?? [])],
    };
  }
}
