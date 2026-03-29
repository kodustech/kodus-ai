import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '@kodus/flow';
import { BetterStackClient } from './betterstack.client';

type IncidentSeverity = 'critical' | 'major' | 'minor';

interface ReportParams {
    key: string;
    title: string;
    description: string;
    component?: string;
}

@Injectable()
export class IncidentManagerService implements OnModuleDestroy {
    private readonly logger = createLogger(IncidentManagerService.name);
    private readonly deduplicationMap = new Map<string, number>();
    private readonly cleanupInterval: ReturnType<typeof setInterval>;

    private static readonly DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

    constructor(
        private readonly betterStackClient: BetterStackClient,
        private readonly configService: ConfigService,
    ) {
        this.cleanupInterval = setInterval(
            () => this.cleanupExpiredEntries(),
            IncidentManagerService.DEDUP_WINDOW_MS,
        );
    }

    onModuleDestroy() {
        clearInterval(this.cleanupInterval);
    }

    async pingHeartbeat(envKey: string): Promise<void> {
        const url = this.resolveHeartbeat(envKey);
        if (!url) return;

        await this.betterStackClient.pingHeartbeat(url);
    }

    async failHeartbeat(
        envKey: string,
        message: string,
        context?: Record<string, unknown>,
    ): Promise<void> {
        const url = this.resolveHeartbeat(envKey);
        if (!url) return;

        await this.betterStackClient.failHeartbeat(url, message, context);
    }

    async reportCritical(params: ReportParams): Promise<void> {
        await this.report('critical', params);
    }

    async reportMajor(params: ReportParams): Promise<void> {
        await this.report('major', params);
    }

    async reportMinor(params: ReportParams): Promise<void> {
        await this.report('minor', params);
    }

    private async report(
        severity: IncidentSeverity,
        params: ReportParams,
    ): Promise<void> {
        const deduplicationKey = `${severity}:${params.key}`;

        if (this.isDuplicate(deduplicationKey)) {
            this.logger.debug({
                message: `Incident deduplicated (already reported within window)`,
                context: IncidentManagerService.name,
                metadata: {
                    key: params.key,
                    severity,
                    title: params.title,
                },
            });
            return;
        }

        this.deduplicationMap.set(deduplicationKey, Date.now());

        this.logger.warn({
            message: `Incident reported: [${severity.toUpperCase()}] ${params.title}`,
            context: IncidentManagerService.name,
            metadata: {
                key: params.key,
                severity,
                title: params.title,
                description: params.description,
                component: params.component,
            },
        });

        const summary = params.component
            ? `[${params.component}] ${params.description}`
            : params.description;

        await this.betterStackClient.createIncident({
            name: params.title,
            summary,
            severity,
        });
    }

    private isDuplicate(key: string): boolean {
        const lastReported = this.deduplicationMap.get(key);

        if (!lastReported) {
            return false;
        }

        const elapsed = Date.now() - lastReported;

        if (elapsed >= IncidentManagerService.DEDUP_WINDOW_MS) {
            this.deduplicationMap.delete(key);
            return false;
        }

        return true;
    }

    private cleanupExpiredEntries(): void {
        const now = Date.now();
        for (const [key, lastReported] of this.deduplicationMap.entries()) {
            if (now - lastReported >= IncidentManagerService.DEDUP_WINDOW_MS) {
                this.deduplicationMap.delete(key);
            }
        }
    }

    private resolveHeartbeat(envKey: string): string | null {
        const url = this.configService.get<string>(envKey);
        if (url) {
            return url;
        }

        this.logger.debug({
            message: `Heartbeat URL not configured for ${envKey}, skipping report`,
            context: IncidentManagerService.name,
        });
        return null;
    }
}
