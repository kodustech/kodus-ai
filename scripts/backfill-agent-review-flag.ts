#!/usr/bin/env npx ts-node
/**
 * Backfill the `agentReviewEnabled` property on PostHog repository groups.
 *
 * By default new repos are created with `agentReviewEnabled: true`
 * (see CreateRepositoriesUseCase). Repos registered before that change
 * have no value for the property in PostHog. This script lets you
 * backfill in bulk with either `false` (keep on legacy pipeline) or
 * `true` (opt in to agent pipeline), scoped by org, by specific repos,
 * or across everything.
 *
 * Usage:
 *   # Dry-run across the whole DB, default value false
 *   npx ts-node scripts/backfill-agent-review-flag.ts --all --dry-run
 *
 *   # Set every existing repo to agentReviewEnabled=false
 *   npx ts-node scripts/backfill-agent-review-flag.ts --all --enabled=false
 *
 *   # Enable all repos of a specific org
 *   npx ts-node scripts/backfill-agent-review-flag.ts --org-id=<uuid> --enabled=true
 *
 *   # Enable specific repos by their platform external id
 *   npx ts-node scripts/backfill-agent-review-flag.ts --repo-ids=123,456,789 --enabled=true
 *
 *   # Use a specific .env file
 *   npx ts-node scripts/backfill-agent-review-flag.ts --all --env=.env.prod
 *
 * Env vars required:
 *   API_POSTHOG_KEY
 *   API_PG_DB_HOST, API_PG_DB_PORT, API_PG_DB_USERNAME, API_PG_DB_PASSWORD, API_PG_DB_DATABASE
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { Client } from 'pg';
import { PostHog } from 'posthog-node';

interface Options {
    orgId?: string;
    repoIds?: string[];
    all: boolean;
    enabled: boolean;
    dryRun: boolean;
}

function parseArgs(): Options {
    const args = process.argv.slice(2);
    const get = (flag: string): string | undefined => {
        const withEq = args.find((a) => a.startsWith(`${flag}=`));
        if (withEq) return withEq.slice(flag.length + 1);
        const i = args.indexOf(flag);
        if (i >= 0 && i + 1 < args.length) return args[i + 1];
        return undefined;
    };

    const orgId = get('--org-id');
    const repoIdsRaw = get('--repo-ids');
    const repoIds = repoIdsRaw
        ? repoIdsRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
    const all = args.includes('--all');
    const enabledRaw = get('--enabled');
    const enabled = enabledRaw ? enabledRaw.toLowerCase() === 'true' : false;
    const dryRun = args.includes('--dry-run');

    const selectors = [orgId ? 1 : 0, repoIds?.length ? 1 : 0, all ? 1 : 0].reduce(
        (a, b) => a + b,
        0,
    );
    if (selectors === 0) {
        throw new Error(
            'Provide one of: --org-id=<uuid>, --repo-ids=<id,id,...>, or --all',
        );
    }
    if (selectors > 1) {
        throw new Error(
            'Use only one of: --org-id, --repo-ids, --all (cannot combine)',
        );
    }

    return { orgId, repoIds, all, enabled, dryRun };
}

function loadEnv() {
    const envArg = process.argv.find((a) => a.startsWith('--env='));
    const envPath = envArg
        ? path.resolve(envArg.split('=')[1])
        : path.resolve(__dirname, '../.env');
    dotenv.config({ path: envPath });
    console.log(`[env] Using env file: ${envPath}`);
}

async function fetchRepos(
    client: Client,
    opts: Options,
): Promise<
    Array<{
        externalId: string;
        name: string;
        fullName: string;
        platform: string;
        organizationId: string;
    }>
> {
    const baseQuery = `
        SELECT
            r.external_id  AS "externalId",
            r.name         AS "name",
            r.full_name    AS "fullName",
            r.platform     AS "platform",
            o.uuid         AS "organizationId"
        FROM repositories r
        JOIN teams t         ON t.uuid = r.integration_config_id
        JOIN organizations o ON o.uuid = t.organization_id
    `;

    if (opts.orgId) {
        const res = await client.query(
            `${baseQuery} WHERE o.uuid = $1`,
            [opts.orgId],
        );
        return res.rows;
    }

    if (opts.repoIds?.length) {
        const res = await client.query(
            `${baseQuery} WHERE r.external_id = ANY($1::text[])`,
            [opts.repoIds],
        );
        return res.rows;
    }

    const res = await client.query(baseQuery);
    return res.rows;
}

async function main() {
    loadEnv();
    const opts = parseArgs();

    const posthogKey = process.env.API_POSTHOG_KEY;
    if (!posthogKey) throw new Error('API_POSTHOG_KEY is required');

    const pgHost = process.env.API_PG_DB_HOST;
    const pgPort = Number(process.env.API_PG_DB_PORT ?? 5432);
    const pgUser = process.env.API_PG_DB_USERNAME;
    const pgPass = process.env.API_PG_DB_PASSWORD;
    const pgDb = process.env.API_PG_DB_DATABASE;
    if (!pgHost || !pgUser || !pgPass || !pgDb) {
        throw new Error(
            'Missing Postgres env vars: API_PG_DB_HOST / USERNAME / PASSWORD / DATABASE',
        );
    }

    const scope = opts.all
        ? 'ALL repos'
        : opts.orgId
          ? `org ${opts.orgId}`
          : `repos [${opts.repoIds!.join(', ')}]`;

    console.log(
        `[backfill] scope=${scope} enabled=${opts.enabled} dryRun=${opts.dryRun}`,
    );

    const client = new Client({
        host: pgHost,
        port: pgPort,
        user: pgUser,
        password: pgPass,
        database: pgDb,
        ssl:
            process.env.API_DATABASE_DISABLE_SSL === 'true'
                ? false
                : { rejectUnauthorized: false },
    });
    await client.connect();

    let repos;
    try {
        repos = await fetchRepos(client, opts);
    } finally {
        await client.end();
    }

    console.log(`[backfill] matched ${repos.length} repository records`);
    if (repos.length === 0) {
        console.log('[backfill] nothing to do — exiting');
        return;
    }

    if (opts.dryRun) {
        for (const r of repos) {
            console.log(
                `[dry-run] repo.${r.externalId} org=${r.organizationId} platform=${r.platform} fullName=${r.fullName}`,
            );
        }
        console.log('[backfill] dry-run complete, no PostHog calls made');
        return;
    }

    const posthog = new PostHog(posthogKey, {
        host: 'https://us.i.posthog.com',
    });

    let done = 0;
    for (const r of repos) {
        posthog.groupIdentify({
            groupType: 'repository',
            groupKey: r.externalId,
            properties: {
                name: r.name,
                fullName: r.fullName,
                platform: r.platform,
                organizationId: r.organizationId,
                repositoryId: r.externalId,
                agentReviewEnabled: opts.enabled,
            },
        });
        done++;
        if (done % 50 === 0) {
            console.log(`[backfill] identified ${done}/${repos.length}`);
        }
    }

    await posthog.shutdown();
    console.log(
        `[backfill] done — ${done} repo groups updated with agentReviewEnabled=${opts.enabled}`,
    );
}

main().catch((err) => {
    console.error('[backfill] failed:', err);
    process.exit(1);
});
