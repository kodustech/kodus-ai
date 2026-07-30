import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

import { createLogger } from '@libs/core/log/logger';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Model } from 'mongoose';
import { DataSource } from 'typeorm';

import { KodyRulesModel } from '@libs/kodyRules/infrastructure/adapters/repositories/schemas/kodyRules.model';
import { PullRequestsModel } from '@libs/platformData/infrastructure/adapters/repositories/schemas/pullRequests.model';

const KNOWN_INTEGRATIONS = new Set([
    'github',
    'gitlab',
    'bitbucket',
    'azure_repos',
    'azure_boards',
    'jira',
    'slack',
    'msteams',
    'discord',
    'notion',
    'forgejo',
]);

/**
 * Shape mirrors the `kodus-beacon` v1 schema (excluding wrapper fields like
 * `schema_version`, `instance_id`, `sent_at`, which the beacon service adds).
 * See `kodus-beacon/docs/api.md` for the canonical definition.
 */
export interface HeartbeatMetrics {
    kodus: {
        version: string;
        deployment:
            | 'docker'
            | 'docker-compose'
            | 'k8s'
            | 'bare'
            | 'unknown';
        uptime_hours: number;
    };
    runtime: {
        node_version: string;
        os: 'linux' | 'darwin' | 'windows';
        arch: string;
        cpu_count: number;
        db_type: string;
        db_version: string;
    };
    usage_7d: {
        active_users: number;
        organizations: number;
        teams: number;
        repos_connected: number;
        prs_reviewed: number;
        suggestions_generated: number;
        suggestions_applied: number;
    };
    config: {
        kody_rules_enabled: boolean;
        agent_review_repos_pct: number;
        integrations: string[];
    };
}

export const HEARTBEAT_COLLECTOR_SERVICE_TOKEN = Symbol.for(
    'HeartbeatCollectorService',
);

export interface IHeartbeatCollectorService {
    collect(input: { firstSeenAt: Date }): Promise<HeartbeatMetrics>;
}

@Injectable()
export class HeartbeatCollectorService implements IHeartbeatCollectorService {
    private readonly logger = createLogger(HeartbeatCollectorService.name);

    constructor(
        @InjectDataSource()
        private readonly dataSource: DataSource,
        @InjectModel(PullRequestsModel.name)
        private readonly pullRequestsModel: Model<unknown>,
        @InjectModel(KodyRulesModel.name)
        private readonly kodyRulesModel: Model<unknown>,
    ) {}

    /**
     * Returns the metric payload for a heartbeat. `firstSeenAt` is the
     * timestamp the instance was first registered, used to derive
     * `uptime_hours` against now.
     *
     * Each metric runs in its own try/catch via `safe()` — a single bad query
     * (schema drift, missing table on a fresh install) yields 0 for that
     * field, never kills the collect.
     */
    async collect(input: { firstSeenAt: Date }): Promise<HeartbeatMetrics> {
        const now = Date.now();
        const uptimeHours = Math.max(
            0,
            Math.floor((now - input.firstSeenAt.getTime()) / 3_600_000),
        );

        const [
            dbVersion,
            organizations,
            teams,
            reposConnected,
            activeUsers,
            integrations,
            prsReviewed,
            kodyRulesEnabled,
        ] = await Promise.all([
            this.safe('db_version', () => this.queryDbVersion(), 'unknown'),
            this.safe('organizations', () => this.countTable('organizations'), 0),
            this.safe('teams', () => this.countTable('teams'), 0),
            this.safe('repos_connected', () => this.countTable('repositories'), 0),
            this.safe('active_users', () => this.queryActiveUsers7d(), 0),
            this.safe('integrations', () => this.queryIntegrations(), []),
            this.safe('prs_reviewed', () => this.queryPrsReviewed7d(), 0),
            this.safe(
                'kody_rules_enabled',
                () => this.queryKodyRulesEnabled(),
                false,
            ),
        ]);

        return {
            kodus: {
                version: detectKodusVersion(),
                deployment: detectDeployment(),
                uptime_hours: uptimeHours,
            },
            runtime: {
                node_version: process.version,
                os: detectOs(),
                arch: process.arch,
                cpu_count: os.cpus().length,
                db_type: 'postgres',
                db_version: dbVersion,
            },
            usage_7d: {
                active_users: activeUsers,
                organizations,
                teams,
                repos_connected: reposConnected,
                prs_reviewed: prsReviewed,
                // Suggestions are embedded inside pullRequests Mongo docs as
                // an array; counting them requires an unwind aggregation
                // across the full collection. Out of scope for v1 — revisit
                // if the receiver-side analytics need it.
                suggestions_generated: 0,
                suggestions_applied: 0,
            },
            config: {
                kody_rules_enabled: kodyRulesEnabled,
                // The agent-review flag is evaluated at runtime via PostHog
                // feature flags, not stored in any Postgres/Mongo table. A
                // truthful number would require querying PostHog directly,
                // which would defeat the "anonymous, self-contained" property
                // of this heartbeat. Reported as 0 until we surface a
                // local mirror of the flag state.
                agent_review_repos_pct: 0,
                integrations,
            },
        };
    }

    private async queryDbVersion(): Promise<string> {
        const rows: Array<{ version: string }> = await this.dataSource.query(
            `SELECT version() AS version`,
        );
        const raw = rows[0]?.version ?? 'unknown';
        // Postgres' version() returns a verbose string like
        // "PostgreSQL 15.4 (Ubuntu 15.4-1.pgdg22.04+1) on x86_64-pc-linux-gnu...";
        // keep just the first two tokens to avoid leaking host details.
        return raw.split(' ').slice(0, 2).join(' ').trim() || 'unknown';
    }

    private async countTable(table: string): Promise<number> {
        const rows: Array<{ count: string }> = await this.dataSource.query(
            `SELECT COUNT(*)::int AS count FROM "${table}"`,
        );
        return Number(rows[0]?.count ?? 0);
    }

    private async queryActiveUsers7d(): Promise<number> {
        // The auth table tracks one row per refresh-token issuance per user;
        // `updatedAt` advances each time the row is touched (rotation, use).
        // Distinct `userUuid` over the last 7 days is the closest signal to
        // "users currently using the product" without a dedicated activity
        // log. Imperfect (a user offline this week with a long-lived token
        // won't appear) but stable and cheap.
        const rows: Array<{ count: string }> = await this.dataSource.query(`
            SELECT COUNT(DISTINCT "userUuid")::int AS count
            FROM auth
            WHERE "updatedAt" > now() - interval '7 days'
        `);
        return Number(rows[0]?.count ?? 0);
    }

    private async queryIntegrations(): Promise<string[]> {
        const rows: Array<{ platform: string }> = await this.dataSource.query(`
            SELECT DISTINCT lower(platform::text) AS platform FROM integrations
        `);
        const seen = new Set<string>();
        for (const row of rows) {
            const normalized = row.platform?.trim().toLowerCase();
            if (!normalized) {
                continue;
            }
            seen.add(KNOWN_INTEGRATIONS.has(normalized) ? normalized : 'other');
        }
        return Array.from(seen).sort();
    }

    private async queryPrsReviewed7d(): Promise<number> {
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        return this.pullRequestsModel
            .countDocuments({ updatedAt: { $gte: since } })
            .exec();
    }

    private async queryKodyRulesEnabled(): Promise<boolean> {
        const count = await this.kodyRulesModel
            .countDocuments({ 'rules.0': { $exists: true } })
            .exec();
        return count > 0;
    }

    private async safe<T>(
        label: string,
        fn: () => Promise<T>,
        fallback: T,
    ): Promise<T> {
        try {
            return await fn();
        } catch (error) {
            this.logger.warn({
                message: `telemetry metric "${label}" failed (using fallback)`,
                context: HeartbeatCollectorService.name,
                metadata: {
                    label,
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            });
            return fallback;
        }
    }
}

// Read once at module load — package.json doesn't change at runtime, and we
// avoid hitting the disk on every heartbeat.
const KODUS_VERSION = readKodusVersion();

function readKodusVersion(): string {
    try {
        const pkg = JSON.parse(
            readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
        ) as { version?: string };
        return pkg.version ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
}

function detectKodusVersion(): string {
    return KODUS_VERSION;
}

function detectDeployment(): HeartbeatMetrics['kodus']['deployment'] {
    if (process.env.KUBERNETES_SERVICE_HOST) {
        return 'k8s';
    }
    if (existsSync('/.dockerenv')) {
        return 'docker';
    }
    return 'unknown';
}

function detectOs(): HeartbeatMetrics['runtime']['os'] {
    if (process.platform === 'linux') {
        return 'linux';
    }
    if (process.platform === 'darwin') {
        return 'darwin';
    }
    if (process.platform === 'win32') {
        return 'windows';
    }
    return 'linux';
}
