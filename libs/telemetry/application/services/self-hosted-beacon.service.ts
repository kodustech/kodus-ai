import { randomUUID } from 'node:crypto';

import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';

import { GlobalParametersKey } from '@libs/core/domain/enums/global-parameters-key.enum';
import { GLOBAL_PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/global-parameters/contracts/global-parameters.service.contract';
import { IGlobalParametersService } from '@libs/organization/domain/global-parameters/contracts/global-parameters.service.contract';

import {
    BEACON_HTTP_PROVIDER_TOKEN,
    IBeaconHttpProvider,
} from '../../infrastructure/providers/beacon-http.provider';
import {
    HEARTBEAT_COLLECTOR_SERVICE_TOKEN,
    IHeartbeatCollectorService,
} from './heartbeat-collector.service';

interface TelemetryStateValue {
    instance_id: string;
    first_seen_at: string; // ISO-8601 UTC
    last_sent_day: string | null; // YYYY-MM-DD UTC
    in_flight_day: string | null; // YYYY-MM-DD UTC
    in_flight_started_at: string | null; // ISO-8601 UTC
}

export const SELF_HOSTED_BEACON_SERVICE_TOKEN = Symbol.for(
    'SelfHostedBeaconService',
);

export interface ISelfHostedBeaconService {
    isDisabled(): boolean;
    run(): Promise<void>;
    preview(): Promise<Record<string, unknown>>;
}

/**
 * Orchestrator for the self-hosted heartbeat. Handles:
 *
 *   - opt-out resolution (`KODUS_TELEMETRY_DISABLED`, `DO_NOT_TRACK`)
 *   - daily dedupe via `last_sent_day` in `global_parameters[telemetry_state]`
 *   - best-effort multi-worker dedupe via `in_flight_day`
 *   - lazy creation + persistence of `instance_id`
 *   - assembling the wire payload from `HeartbeatCollectorService`
 *   - delegating transport to `BeaconHttpProvider`
 *
 * The cron is the only caller. Failures never propagate — telemetry must
 * never break a host flow.
 */
@Injectable()
export class SelfHostedBeaconService implements ISelfHostedBeaconService {
    private readonly logger = createLogger(SelfHostedBeaconService.name);

    constructor(
        @Inject(GLOBAL_PARAMETERS_SERVICE_TOKEN)
        private readonly globalParameters: IGlobalParametersService,
        @Inject(HEARTBEAT_COLLECTOR_SERVICE_TOKEN)
        private readonly collector: IHeartbeatCollectorService,
        @Inject(BEACON_HTTP_PROVIDER_TOKEN)
        private readonly transport: IBeaconHttpProvider,
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
        let claimedState: TelemetryStateValue | null = null;

        try {
            if (this.transport.isDisabled()) {
                return;
            }

            const today = utcDayString(new Date());
            const state = await this.loadOrInitState();

            if (state.last_sent_day === today) {
                return;
            }

            if (hasFreshInFlightClaim(state, today, new Date())) {
                return;
            }

            const nextClaimedState: TelemetryStateValue = {
                ...state,
                in_flight_day: today,
                in_flight_started_at: new Date().toISOString(),
            };

            await this.persistState(nextClaimedState);
            claimedState = nextClaimedState;

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
                    ...claimedState,
                    last_sent_day: today,
                    in_flight_day: null,
                    in_flight_started_at: null,
                });
            } else {
                await this.persistState(clearInFlightClaim(claimedState));
            }
        } catch (error) {
            // Defense in depth: any unexpected throw is swallowed so the cron
            // never fails the worker. The transport already swallows network
            // errors; this catches storage / collector bugs.
            if (claimedState) {
                try {
                    await this.persistState(clearInFlightClaim(claimedState));
                } catch {
                    // If cleanup also fails, keep the original error as the
                    // useful signal. A stale in-flight claim expires.
                }
            }

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
                in_flight_day: value.in_flight_day ?? null,
                in_flight_started_at: value.in_flight_started_at ?? null,
            };
        }

        const fresh: TelemetryStateValue = {
            instance_id: randomUUID(),
            first_seen_at: new Date().toISOString(),
            last_sent_day: null,
            in_flight_day: null,
            in_flight_started_at: null,
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

function hasFreshInFlightClaim(
    state: TelemetryStateValue,
    today: string,
    now: Date,
): boolean {
    if (
        state.in_flight_day !== today ||
        !state.in_flight_started_at ||
        Number.isNaN(Date.parse(state.in_flight_started_at))
    ) {
        return false;
    }

    const startedAt = new Date(state.in_flight_started_at).getTime();
    return now.getTime() - startedAt < 30 * 60 * 1000;
}

function clearInFlightClaim(
    state: TelemetryStateValue,
): TelemetryStateValue {
    return {
        ...state,
        in_flight_day: null,
        in_flight_started_at: null,
    };
}
