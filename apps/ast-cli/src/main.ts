/**
 * AST graph backfill — SQL-only.
 *
 * Why this exists: `kodus-graph` is built per-repo at the moment a repo
 * is selected (CreateRepositoriesUseCase). Self-hosted operators
 * upgrading from a release that predates the AST graph have repos in
 * `integration_configs` (configKey = 'repositories') without a
 * corresponding row in `repositories`, or with `ast_graph_status` of
 * `pending` / `failed`. This script walks every active team in the
 * instance and enqueues an `AstGraphBuild` job for each repo that
 * needs one.
 *
 * The script writes ONLY to Postgres — `repositories`,
 * `kodus_workflow.workflow_jobs`, `kodus_workflow.outbox_messages` —
 * inside a transaction per repo. The existing **outbox relay** (which
 * runs in the worker) picks each row up and publishes to RabbitMQ.
 * That means the script does NOT need to talk to Rabbit, NestJS, or
 * any of kodus-ai's modules — it stays trivially small and avoids the
 * webpack TDZ pitfalls of bootstrapping the full app.
 *
 * Idempotency:
 *   - `ast_graph_status = 'building'`  → never re-enqueued
 *   - `ast_graph_status = 'ready'`     → enqueued only with --force
 *   - `pending` / `failed` / NULL      → enqueued
 *
 * Usage:
 *   yarn ast:backfill                  # dev (ts-node)
 *   yarn ast:backfill:prod             # prod (compiled, run inside docker compose exec)
 *
 *   --org <organizationId>             # restrict to one org
 *   --team <teamId>                    # restrict to one team (requires --org)
 *   --force                            # also re-enqueue READY repos
 *   --limit <N>                        # cap jobs enqueued per team (default: 10)
 *   --dry-run                          # report what would happen, write nothing
 */
import 'dotenv/config';

import { randomUUID } from 'crypto';
import { Client } from 'pg';

interface CliArgs {
    org?: string;
    team?: string;
    force: boolean;
    limit: number;
    dryRun: boolean;
}

function parseArgs(): CliArgs {
    const out: CliArgs = { force: false, limit: 10, dryRun: false };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];
        switch (arg) {
            case '--org':
                out.org = next;
                i += 1;
                break;
            case '--team':
                out.team = next;
                i += 1;
                break;
            case '--force':
                out.force = true;
                break;
            case '--limit':
                out.limit = Number(next);
                i += 1;
                break;
            case '--dry-run':
                out.dryRun = true;
                break;
            default:
                if (arg?.startsWith('--')) {
                    throw new Error(`unknown flag: ${arg}`);
                }
        }
    }
    if (out.team && !out.org) {
        throw new Error('--team requires --org');
    }
    if (!Number.isFinite(out.limit) || out.limit <= 0) {
        throw new Error('--limit must be a positive number');
    }
    return out;
}

interface Repo {
    id: string | number;
    name?: string;
    full_name?: string;
    fullName?: string;
    organizationName?: string;
    http_url?: string;
    default_branch?: string;
    selected?: boolean;
}

function envOrThrow(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`missing required env var: ${name}`);
    return v;
}

function buildClient(): Client {
    // Mirror the same precedence kodus-ai's loader uses: a full
    // DATABASE_URL / API_PG_DB_URL wins over individual vars. Self-hosted
    // installs typically set the individual vars, but managed-Postgres
    // setups (Supabase / RDS / Neon) hand you a single connection string.
    const url = process.env.DATABASE_URL || process.env.API_PG_DB_URL;
    if (url) return new Client({ connectionString: url });

    return new Client({
        host: envOrThrow('API_PG_DB_HOST'),
        port: Number(process.env.API_PG_DB_PORT || 5432),
        user: envOrThrow('API_PG_DB_USERNAME'),
        password: envOrThrow('API_PG_DB_PASSWORD'),
        database: envOrThrow('API_PG_DB_DATABASE'),
    });
}

async function main() {
    const args = parseArgs();
    const client = buildClient();
    await client.connect();

    try {
        // 1) List active teams (optionally narrowed by --org / --team).
        const teamRows = await client.query<{
            team_id: string;
            organization_id: string;
        }>(
            `SELECT t.uuid AS team_id, t.organization_id
             FROM teams t
             WHERE t.status = 'active'
               AND ($1::uuid IS NULL OR t.organization_id = $1::uuid)
               AND ($2::uuid IS NULL OR t.uuid = $2::uuid)
             ORDER BY t.organization_id, t.uuid`,
            [args.org ?? null, args.team ?? null],
        );

        console.log(
            `Resolved ${teamRows.rowCount} team(s) — force=${args.force} limit/team=${args.limit} dryRun=${args.dryRun}`,
        );

        const totals = {
            teams: 0,
            matched: 0,
            enqueued: 0,
            skipped: 0,
            errors: 0,
        };

        for (const { team_id, organization_id } of teamRows.rows) {
            totals.teams += 1;

            // 2) Fetch the REPOSITORIES integration config + its platform.
            //    `integration_config_id` is the FK target on `repositories`,
            //    so we MUST carry ic.uuid through — using team_id there
            //    causes a constraint violation on insert.
            const cfgRow = await client.query<{
                integration_config_id: string;
                config_value: Repo[];
                platform: string;
            }>(
                `SELECT ic.uuid AS integration_config_id,
                        ic."configValue" AS config_value,
                        i.platform AS platform
                 FROM integration_configs ic
                 JOIN integrations i ON i.uuid = ic.integration_id
                 WHERE ic.team_id = $1 AND ic."configKey" = 'repositories'
                 LIMIT 1`,
                [team_id],
            );

            if (cfgRow.rowCount === 0) {
                console.log(
                    `  org=${organization_id} team=${team_id} — no repositories config, skipping`,
                );
                continue;
            }

            const { integration_config_id, config_value, platform } =
                cfgRow.rows[0];
            const repos = (config_value || []).filter(
                (r) => r?.id && r.selected !== false,
            );
            const matched = repos.length;
            totals.matched += matched;

            let enqueuedForTeam = 0;
            let skippedForTeam = 0;
            let errorsForTeam = 0;

            for (const repo of repos) {
                if (enqueuedForTeam >= args.limit) break;
                const fullName =
                    repo.full_name ||
                    repo.fullName ||
                    (repo.name && repo.organizationName
                        ? `${repo.organizationName}/${repo.name}`
                        : repo.name) ||
                    String(repo.id);

                try {
                    // findOrCreate: ON CONFLICT (platform, external_id) returns
                    // the existing row, NEW rows default to ast_graph_status='pending'.
                    const upsert = await client.query<{
                        uuid: string;
                        ast_graph_status: string | null;
                        default_branch: string;
                    }>(
                        `INSERT INTO repositories
                            (integration_config_id, external_id, name, full_name, platform, default_branch)
                         VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'main'))
                         ON CONFLICT ON CONSTRAINT "UQ_repositories_platform_external"
                         DO UPDATE SET full_name = EXCLUDED.full_name
                         RETURNING uuid, ast_graph_status, default_branch`,
                        [
                            integration_config_id,
                            String(repo.id),
                            repo.name || fullName,
                            fullName,
                            platform,
                            repo.default_branch || null,
                        ],
                    );

                    const row = upsert.rows[0];
                    const status = row.ast_graph_status;

                    if (status === 'building') {
                        skippedForTeam += 1;
                        continue;
                    }
                    if (status === 'ready' && !args.force) {
                        skippedForTeam += 1;
                        continue;
                    }

                    if (args.dryRun) {
                        enqueuedForTeam += 1;
                        continue;
                    }

                    // Transactional enqueue: workflow_jobs + outbox_messages.
                    // The outbox relay (running in the worker) ships the
                    // outbox row to RabbitMQ asynchronously.
                    await client.query('BEGIN');
                    try {
                        const jobUuid = randomUUID();
                        const jobPayload = {
                            repositoryId: row.uuid,
                            cloneUrl: repo.http_url || '',
                            defaultBranch: row.default_branch,
                            fullName,
                            platform,
                            organizationAndTeamData: {
                                organizationId: organization_id,
                                teamId: team_id,
                            },
                        };

                        await client.query(
                            `INSERT INTO kodus_workflow.workflow_jobs (
                                uuid, "correlationId", "workflowType", "handlerType",
                                payload, status, priority, "retryCount", "maxRetries",
                                "organizationId", "teamId"
                            ) VALUES (
                                $1, $2, 'AST_GRAPH_BUILD', 'SIMPLE_FUNCTION',
                                $3::jsonb, 'PENDING', 0, 0, 3,
                                $4, $5
                            )`,
                            [
                                jobUuid,
                                team_id,
                                JSON.stringify(jobPayload),
                                organization_id,
                                team_id,
                            ],
                        );

                        const eventName = 'workflow.jobs.created';
                        const outboxPayload = {
                            event_name: eventName,
                            payload: {
                                jobId: jobUuid,
                                correlationId: team_id,
                                workflowType: 'AST_GRAPH_BUILD',
                                handlerType: 'SIMPLE_FUNCTION',
                                organizationId: organization_id,
                                teamId: team_id,
                            },
                            event_version: 1,
                            occurred_on: new Date().toISOString(),
                            messageId: `${eventName}-${Date.now()}-${randomUUID().slice(0, 13)}`,
                        };

                        await client.query(
                            `INSERT INTO kodus_workflow.outbox_messages (
                                job_id, exchange, "routingKey", payload, status, attempts
                            ) VALUES (
                                $1, 'workflow.exchange',
                                'workflow.jobs.created.AST_GRAPH_BUILD',
                                $2::jsonb, 'READY', 0
                            )`,
                            [jobUuid, JSON.stringify(outboxPayload)],
                        );

                        await client.query('COMMIT');
                        enqueuedForTeam += 1;
                    } catch (txErr) {
                        await client.query('ROLLBACK');
                        throw txErr;
                    }
                } catch (err) {
                    errorsForTeam += 1;
                    const msg = err instanceof Error ? err.message : String(err);
                    console.warn(
                        `  org=${organization_id} team=${team_id} repo=${fullName} — ${msg}`,
                    );
                }
            }

            totals.enqueued += enqueuedForTeam;
            totals.skipped += skippedForTeam;
            totals.errors += errorsForTeam;

            console.log(
                `  org=${organization_id} team=${team_id} matched=${matched} enqueued=${enqueuedForTeam} skipped=${skippedForTeam} errors=${errorsForTeam}`,
            );
        }

        console.log(
            `Done. teams=${totals.teams} matched=${totals.matched} enqueued=${totals.enqueued} skipped=${totals.skipped} errors=${totals.errors}${args.dryRun ? ' (dry-run)' : ''}`,
        );
    } finally {
        await client.end();
    }
}

main().catch((err) => {
     
    console.error('ast-backfill crashed:', err);
    process.exit(1);
});
