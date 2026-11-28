import { Module } from '@nestjs/common';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { RuntimeApiModule } from '@libs/runtime/api/runtime-api.module';
import {
    RUNTIME_CLOCK,
    RUNTIME_RUN_PROJECTION_STORE,
    type Clock,
    type RunProjectionReader,
} from '@libs/runtime/api/domain/ports';
import { TypeOrmExternalFindingsStore } from '@libs/runtime/api/infrastructure/typeorm-external-findings.store';
import { ExternalVerificationReconciler } from '@libs/runtime/api/application/external-verification-reconciler';
import { ProductExternalMaintenanceDatabase } from './maintenance-database';
import { ExternalMaintenanceCandidates } from './maintenance-candidates';
import { ExternalMaintenanceSweep } from './maintenance-sweep';
import {
    EXTERNAL_MAINTENANCE_OPTIONS,
    EXTERNAL_MAINTENANCE_RUNTIME,
    RuntimeExternalMaintenanceCron,
    type ExternalMaintenanceRuntime,
    type ExternalMaintenanceRuntimeFactory,
} from './maintenance.cron';

/** Imported only by the opted-in code-review product worker, never the API or analytics worker. */
@Module({
    imports: [RuntimeApiModule],
    providers: [
        ProductExternalMaintenanceDatabase,
        ExternalMaintenanceCandidates,
        {
            provide: EXTERNAL_MAINTENANCE_OPTIONS,
            useValue: { enabled: true, budgetMs: 40000 },
        },
        {
            provide: EXTERNAL_MAINTENANCE_RUNTIME,
            inject: [
                ProductExternalMaintenanceDatabase,
                ExternalMaintenanceCandidates,
                RUNTIME_RUN_PROJECTION_STORE,
                RUNTIME_CLOCK,
            ],
            useFactory: (
                database: ProductExternalMaintenanceDatabase,
                candidates: ExternalMaintenanceCandidates,
                runs: RunProjectionReader,
                now: Clock,
            ): ExternalMaintenanceRuntimeFactory => {
                let current: Promise<ExternalMaintenanceRuntime> | undefined;
                return () => {
                    current ??= database
                        .source()
                        .then((source) => {
                            const store = new TypeOrmExternalFindingsStore(
                                source,
                                {
                                    create: async () => {
                                        throw new Error(
                                            'Maintenance cannot admit execution',
                                        );
                                    },
                                },
                            );
                            return {
                                locks: new DistributedLockService(source),
                                sweep: new ExternalMaintenanceSweep(
                                    candidates,
                                    store,
                                    new ExternalVerificationReconciler(
                                        store,
                                        runs,
                                        now,
                                    ),
                                    now,
                                    {
                                        maxTasks: 25,
                                        candidateWindow: 100,
                                        retentionDays: 30,
                                    },
                                ),
                            };
                        })
                        .catch((cause: unknown) => {
                            current = undefined;
                            throw new Error(
                                'External maintenance database unavailable',
                                { cause },
                            );
                        });
                    return current;
                };
            },
        },
        RuntimeExternalMaintenanceCron,
    ],
})
export class RuntimeExternalMaintenanceModule {}
