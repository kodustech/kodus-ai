import { randomUUID } from 'node:crypto';

import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';

import { GlobalParametersKey } from '@libs/core/domain/enums/global-parameters-key.enum';
import { GLOBAL_PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/global-parameters/contracts/global-parameters.service.contract';
import { IGlobalParametersService } from '@libs/organization/domain/global-parameters/contracts/global-parameters.service.contract';

import { BeaconHttpProvider } from '../../infrastructure/providers/beacon-http.provider';
import { HeartbeatCollectorService } from './heartbeat-collector.service';

interface TelemetryStateValue {
    instance_id: string;
    first_seen_at: string; // ISO-8601 UTC
    last_sent_day: string | null; // YYYY-MM-DD UTC
}

/**
 * Orchestrator for the self-hosted heartbeat. Handles:
 *
 *   - opt-out resolution (`KODUS_TELEMETRY_DISABLED`, `DO_NOT_TRACK`)
 *   - daily dedupe via `last_sent_day` in `global_parameters[telemetry_state]`
 *   - lazy creation + persistence of `instance_id`
 *   - assembling the wire payload from `HeartbeatCollectorService`
 *   - delegating transport to `BeaconHttpProvider`
 *
 * The cron is the only caller. Failures never propagate — telemetry must
 * never break a host flow.
 */
@Injectable()
export class SelfHostedBeaconService {
    private readonly logger = createLogger(SelfHostedBeaconService.name);

    constructor(
        @Inject(GLOBAL_PARAMETERS_SERVICE_TOKEN)
        private readonly globalParameters: IGlobalParametersService,
        private readonly collector: HeartbeatCollectorService,
        private readonly transport: BeaconHttpProvider,
    ) {}

    /**
     * Whether telemetry is currently opted out via env. Pass-through to the
     * transport so the cron can log the state at boot without depending on
     * the provider directly.
     */
    isDisabled(): boolean {
        return this.transport.isDisabled();
    }

    /** Daily entrypoint. Idempotent within the same UTC day. */
    async run(): Promise<void> {
        try {
            if (this.transport.isDisabled()) {
                return;
            }

            const today = utcDayString(new Date());
            const state = await this.loadOrInitState();

            if (state.last_sent_day === today) {
                return;
            }

            const metrics = await this.collector.collect({
                firstSeenAt: new Date(state.first_seen_at),
            });

            const payload = {
                schema_version: 1,
                instance_id: state.instance_id,
                sent_at: new Date().toISOString(),
                ...metrics,
            };

            const ok = await this.transport.send(
                payload,
                metrics.kodus.version,
            );

            if (ok) {
                await this.persistState({
                    ...state,
                    last_sent_day: today,
                });
            }
        } catch (error) {
            // Defense in depth: any unexpected throw is swallowed so the cron
            // never fails the worker. The transport already swallows network
            // errors; this catches storage / collector bugs.
            this.logger.warn({
                message: 'self-hosted beacon run failed (swallowed)',
                context: SelfHostedBeaconService.name,
                metadata: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            });
        }
    }

    /**
     * Returns the JSON payload that would be sent right now, without sending
     * it. Powers the `yarn telemetry:preview` transparency command — operators
     * can inspect exactly what leaves their instance.
     */
    async preview(): Promise<Record<string, unknown>> {
        const state = await this.loadOrInitState();
        const metrics = await this.collector.collect({
            firstSeenAt: new Date(state.first_seen_at),
        });

        return {
            schema_version: 1,
            instance_id: state.instance_id,
            sent_at: new Date().toISOString(),
            ...metrics,
        };
    }

    private async loadOrInitState(): Promise<TelemetryStateValue> {
        const existing = await this.globalParameters.findByKey(
            GlobalParametersKey.TELEMETRY_STATE,
        );
        const value = existing?.configValue as
            | TelemetryStateValue
            | undefined;

        if (value && value.instance_id && value.first_seen_at) {
            // Defensive: the receiver tolerates missing last_sent_day; we
            // don't.
            return {
                instance_id: value.instance_id,
                first_seen_at: value.first_seen_at,
                last_sent_day: value.last_sent_day ?? null,
            };
        }

        const fresh: TelemetryStateValue = {
            instance_id: randomUUID(),
            first_seen_at: new Date().toISOString(),
            last_sent_day: null,
        };

        await this.persistState(fresh);
        return fresh;
    }

    private async persistState(value: TelemetryStateValue): Promise<void> {
        await this.globalParameters.createOrUpdateConfig(
            GlobalParametersKey.TELEMETRY_STATE,
            value,
        );
    }
}

function utcDayString(date: Date): string {
    return date.toISOString().slice(0, 10);
}
