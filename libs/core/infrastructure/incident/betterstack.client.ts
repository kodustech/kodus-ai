import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { createLogger } from '@kodus/flow';

export interface CreateIncidentParams {
    name: string;
    summary: string;
    severity: 'critical' | 'major' | 'minor';
}

export interface BetterStackIncident {
    id: string;
    type: string;
    attributes: {
        name: string;
        status: string;
        severity: string;
    };
}

@Injectable()
export class BetterStackClient {
    private readonly logger = createLogger(BetterStackClient.name);
    private readonly client: AxiosInstance | null;
    private consecutiveFailures = 0;
    private circuitOpenUntil = 0;

    private static readonly MAX_FAILURES = 3;
    private static readonly CIRCUIT_OPEN_DURATION_MS = 60_000;

    constructor(private readonly configService: ConfigService) {
        const token = this.configService.get<string>(
            'API_BETTERSTACK_API_TOKEN',
        );

        if (!token) {
            this.logger.warn({
                message:
                    'API_BETTERSTACK_API_TOKEN not configured. Incident creation disabled.',
                context: BetterStackClient.name,
            });
            this.client = null;
            return;
        }

        this.client = axios.create({
            baseURL: 'https://uptime.betterstack.com/api/v2',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            timeout: 10_000,
        });
    }

    async createIncident(
        params: CreateIncidentParams,
    ): Promise<BetterStackIncident | null> {
        if (!this.client) {
            return null;
        }

        if (this.isCircuitOpen()) {
            this.logger.warn({
                message:
                    'BetterStack circuit breaker is open. Skipping incident creation.',
                context: BetterStackClient.name,
                metadata: {
                    incidentName: params.name,
                    circuitOpenUntil: new Date(
                        this.circuitOpenUntil,
                    ).toISOString(),
                },
            });
            return null;
        }

        try {
            const response = await this.client.post('/incidents', {
                name: params.name,
                summary: params.summary,
                // BetterStack API does not have a severity field on create,
                // but we include call and sms flags based on severity
                call: params.severity === 'critical',
                sms:
                    params.severity === 'critical' ||
                    params.severity === 'major',
            });

            this.consecutiveFailures = 0;

            this.logger.log({
                message: 'BetterStack incident created',
                context: BetterStackClient.name,
                metadata: {
                    incidentId: response.data?.data?.id,
                    name: params.name,
                    severity: params.severity,
                },
            });

            return response.data?.data ?? null;
        } catch (error) {
            this.consecutiveFailures++;

            if (this.consecutiveFailures >= BetterStackClient.MAX_FAILURES) {
                this.circuitOpenUntil =
                    Date.now() + BetterStackClient.CIRCUIT_OPEN_DURATION_MS;
                this.logger.error({
                    message: `BetterStack circuit breaker opened after ${this.consecutiveFailures} consecutive failures`,
                    context: BetterStackClient.name,
                    error: error instanceof Error ? error : undefined,
                });
            } else {
                this.logger.error({
                    message: 'Failed to create BetterStack incident',
                    context: BetterStackClient.name,
                    error: error instanceof Error ? error : undefined,
                    metadata: {
                        consecutiveFailures: this.consecutiveFailures,
                        name: params.name,
                    },
                });
            }

            return null;
        }
    }

    async resolveIncident(incidentId: string): Promise<boolean> {
        if (!this.client) {
            return false;
        }

        if (this.isCircuitOpen()) {
            return false;
        }

        try {
            await this.client.post(`/incidents/${incidentId}/resolve`);
            this.consecutiveFailures = 0;

            this.logger.log({
                message: 'BetterStack incident resolved',
                context: BetterStackClient.name,
                metadata: { incidentId },
            });

            return true;
        } catch (error) {
            this.consecutiveFailures++;

            if (this.consecutiveFailures >= BetterStackClient.MAX_FAILURES) {
                this.circuitOpenUntil =
                    Date.now() + BetterStackClient.CIRCUIT_OPEN_DURATION_MS;
            }

            this.logger.error({
                message: 'Failed to resolve BetterStack incident',
                context: BetterStackClient.name,
                error: error instanceof Error ? error : undefined,
                metadata: { incidentId },
            });

            return false;
        }
    }

    async pingHeartbeat(heartbeatUrl: string): Promise<void> {
        const heartbeatTarget = this.redactHeartbeatUrl(heartbeatUrl);
        try {
            await axios.get(heartbeatUrl, { timeout: 10_000 });
            this.logger.debug({
                message: 'Heartbeat ping sent',
                context: BetterStackClient.name,
                metadata: { heartbeatTarget },
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to send heartbeat ping',
                context: BetterStackClient.name,
                error: error instanceof Error ? error : undefined,
                metadata: { heartbeatTarget },
            });
        }
    }

    async failHeartbeat(
        heartbeatUrl: string,
        message?: string,
        context?: Record<string, unknown>,
    ): Promise<void> {
        const heartbeatTarget = this.redactHeartbeatUrl(heartbeatUrl);
        try {
            // O Better Stack /fail exibe qualquer campo extra na UI,
            // e os valores "extra" e "context" muitas vezes ganham tratamento especial.
            const payload = {
                ...(message ? { message } : {}),
                context: context || {},
            };

            await axios.post(
                `${heartbeatUrl}/fail`,
                Object.keys(payload).length > 0 ? payload : undefined,
                { timeout: 10_000 },
            );
            this.logger.warn({
                message: 'Heartbeat fail reported',
                context: BetterStackClient.name,
                metadata: { heartbeatTarget, failMessage: message, ...context },
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to send heartbeat fail',
                context: BetterStackClient.name,
                error: error instanceof Error ? error : undefined,
                metadata: { heartbeatTarget },
            });
        }
    }

    private redactHeartbeatUrl(heartbeatUrl: string): string {
        try {
            const parsed = new URL(heartbeatUrl);
            const segments = parsed.pathname.split('/').filter(Boolean);
            const token = segments.at(-1);

            if (!token) {
                return parsed.origin;
            }

            const prefix = token.slice(0, 4);
            const suffix = token.slice(-4);

            segments[segments.length - 1] = `${prefix}...${suffix}`;
            return `${parsed.origin}/${segments.join('/')}`;
        } catch {
            return 'invalid-heartbeat-url';
        }
    }

    private isCircuitOpen(): boolean {
        if (this.circuitOpenUntil === 0) {
            return false;
        }

        if (Date.now() >= this.circuitOpenUntil) {
            // Reset circuit breaker
            this.circuitOpenUntil = 0;
            this.consecutiveFailures = 0;
            this.logger.log({
                message: 'BetterStack circuit breaker reset',
                context: BetterStackClient.name,
            });
            return false;
        }

        return true;
    }
}
