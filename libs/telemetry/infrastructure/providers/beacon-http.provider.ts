import { createLogger } from '@libs/core/log/logger';
import { Injectable } from '@nestjs/common';

const DEFAULT_ENDPOINT = 'https://telemetry.kodus.io/v1/heartbeat';
const TIMEOUT_MS = 5_000;

export const BEACON_HTTP_PROVIDER_TOKEN = Symbol.for('BeaconHttpProvider');

export interface IBeaconHttpProvider {
    isDisabled(): boolean;
    send(
        payload: Record<string, unknown>,
        kodusVersion: string,
    ): Promise<boolean>;
}

/**
 * Pure HTTP transport for the self-hosted beacon. One responsibility: POST a
 * pre-built payload to the receiver and surface only "did it land" — the
 * caller decides what to do on failure.
 *
 * Opt-out is the only knob: `KODUS_TELEMETRY_DISABLED=1` (also accepts
 * `true`/`yes`/`on`, case-insensitive). Read on every call so operators can
 * flip it at runtime without restarting the worker.
 */
@Injectable()
export class BeaconHttpProvider implements IBeaconHttpProvider {
    private readonly logger = createLogger(BeaconHttpProvider.name);

    isDisabled(): boolean {
        const value = process.env.KODUS_TELEMETRY_DISABLED;
        if (!value) {
            return false;
        }
        return /^(1|true|yes|on)$/i.test(value);
    }

    async send(
        payload: Record<string, unknown>,
        kodusVersion: string,
    ): Promise<boolean> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
            const response = await fetch(this.endpoint(), {
                body: JSON.stringify(payload),
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': `kodus-self-hosted/${kodusVersion}`,
                },
                method: 'POST',
                signal: controller.signal,
            });

            if (response.status === 204) {
                return true;
            }

            this.logger.warn({
                message: 'beacon rejected heartbeat',
                context: BeaconHttpProvider.name,
                metadata: { status: response.status },
            });
            return false;
        } catch (error) {
            this.logger.warn({
                message: 'beacon transport failed',
                context: BeaconHttpProvider.name,
                metadata: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            });
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    private endpoint(): string {
        return process.env.KODUS_TELEMETRY_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
    }
}
