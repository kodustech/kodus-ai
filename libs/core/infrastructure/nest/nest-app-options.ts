import type { NestApplicationContextOptions } from '@nestjs/common/interfaces/nest-application-context-options.interface';

/**
 * Options every Nest entry point boots with: spread them into each
 * `NestFactory.create` / `createApplicationContext` call.
 *
 * Nest 11 identifies dynamic modules by reference: two identical
 * `forRoot()` imports (ScheduleModule in CronModule and NotificationModule)
 * became two instances, and every @Cron and some @OnEvent handlers ran
 * twice per process. 'deep-hash' keeps one instance per identical module.
 *
 * No `snapshot: true`: it needs @nestjs/devtools-integration, which is not
 * installed, and past @nestjs/core 11.1.19 it hangs NestFactory.create()
 * with no error.
 */
export const NEST_APP_OPTIONS = {
    moduleIdGeneratorAlgorithm: 'deep-hash',
} as const satisfies NestApplicationContextOptions;
