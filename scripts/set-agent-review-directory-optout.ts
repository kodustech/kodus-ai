#!/usr/bin/env npx ts-node
/**
 * Temporary internal tool — adds every directory belonging to a given
 * org to the `agent-review` flag's directory opt-out list in PostHog.
 *
 * Edit the constants below before running. The org id, flag key, and
 * APPLY guard are intentionally in-source so the operator reviews them
 * each time.
 *
 *   # Dry-run against local Postgres + PostHog
 *   npx ts-node scripts/set-agent-review-directory-optout.ts
 *
 *   # Apply against cloud (pass a different env file)
 *   npx ts-node scripts/set-agent-review-directory-optout.ts --env=.env.prod
 *
 * Required env vars:
 *   API_PG_DB_HOST, API_PG_DB_PORT, API_PG_DB_USERNAME,
 *   API_PG_DB_PASSWORD, API_PG_DB_DATABASE
 *   API_POSTHOG_KEY           (project write key — used to register the
 *                              `directory` group type via groupIdentify)
 *   POSTHOG_PERSONAL_API_KEY  (personal API key, NOT the public project key)
 *   POSTHOG_PROJECT_ID        (numeric, from the project URL)
 *   POSTHOG_HOST              (optional, defaults to https://us.i.posthog.com)
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { Client } from 'pg';
import { PostHog } from 'posthog-node';

// ─── Edit these before running ──────────────────────────────────────
const ORG_ID = '';
const FLAG_KEY = 'agent-review';
const GROUP_TYPE = 'repositoryDirectory';
/**
 * Separator + sentinel joining repositoryId + directoryId into the
 * composite group key. Must match the constants in
 * `libs/code-review/pipeline/utils/repository-directory-key.ts` —
 * the pipeline gate builds the same keys when probing the flag.
 */
const REPOSITORY_DIRECTORY_KEY_SEPARATOR = ':';
/** Sentinel meaning "any directory in this repo" — repo-wide opt-out. */
const REPOSITORY_WIDE_DIRECTORY_SENTINEL = '*';
/** Flip to true to actually PATCH the flag. Default is dry-run. */
const APPLY = true;
// ────────────────────────────────────────────────────────────────────

interface RepositoryDirectoryPair {
    repositoryId: string;
    /** Directory id, or `*` for a repo-wide opt-out. */
    directoryId: string;
    /** `${repositoryId}:${directoryId}` — what we send to PostHog. */
    compositeKey: string;
}

interface PostHogGroupType {
    group_type: string;
    group_type_index: number;
}

interface PostHogFlagProperty {
    key: string;
    value: string | string[];
    operator?: string;
    type?: string;
    group_type_index?: number;
}

interface PostHogFlagConditionGroup {
    properties?: PostHogFlagProperty[];
    rollout_percentage?: number;
    variant?: string | null;
    aggregation_group_type_index?: number | null;
}

interface PostHogFlag {
    id: number;
    key: string;
    /**
     * Top-level group aggregation. When set, the flag is evaluated per
     * group instance (e.g. per directory) instead of per person.
     * `null` / absent → person-aggregated.
     */
    aggregation_group_type_index?: number | null;
    filters: {
        groups: PostHogFlagConditionGroup[];
        [k: string]: unknown;
    };
    [k: string]: unknown;
}

function loadEnv(): void {
    const envArg = process.argv.find((a) => a.startsWith('--env='));
    const envPath = envArg
        ? path.resolve(envArg.split('=')[1])
        : path.resolve(__dirname, '../.env');
    dotenv.config({ path: envPath });
    console.log(`[env] using env file: ${envPath}`);
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
}

async function fetchRepositoryDirectoryPairsForOrg(
    pg: Client,
    organizationId: string,
): Promise<RepositoryDirectoryPair[]> {
    const result = await pg.query(
        `SELECT p."configValue"
         FROM parameters p
         JOIN teams t ON t.uuid = p.team_id
         WHERE t.organization_id = $1
           AND p."configKey" = 'code_review_config'
           AND p.active = true`,
        [organizationId],
    );

    // Each row's configValue is a CodeReviewParameter JSON. For every
    // repository we emit BOTH:
    //   - `${repoId}:*` (the repo-wide sentinel) so the gate's
    //     always-first repo-wide probe will deny the whole repo, AND
    //   - `${repoId}:${folder.id}` for each inner folder.id
    //     (DirectoryFolder.id — one per configured path).
    // The composites are what the pipeline gate passes as the
    // `repositoryDirectory` PostHog group key. Net effect: every org
    // passed to this script is fully opted out of agent mode across
    // every repo, regardless of which directory a PR touches.
    const pairs = new Map<string, RepositoryDirectoryPair>();
    const emit = (repositoryId: string, directoryId: string): void => {
        const compositeKey = `${repositoryId}${REPOSITORY_DIRECTORY_KEY_SEPARATOR}${directoryId}`;
        pairs.set(compositeKey, { repositoryId, directoryId, compositeKey });
    };

    for (const row of result.rows) {
        const repositories = row.configValue?.repositories ?? [];
        for (const repo of repositories) {
            const repositoryId = repo?.id;
            if (!repositoryId) continue;

            emit(repositoryId, REPOSITORY_WIDE_DIRECTORY_SENTINEL);

            for (const group of repo.directories ?? []) {
                for (const folder of group?.folders ?? []) {
                    if (folder?.id) emit(repositoryId, folder.id);
                }
            }
        }
    }
    return Array.from(pairs.values());
}

async function postHogGet<T>(
    host: string,
    projectId: string,
    apiKey: string,
    pathSuffix: string,
): Promise<T> {
    const res = await fetch(`${host}/api/projects/${projectId}/${pathSuffix}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
        throw new Error(
            `PostHog GET ${pathSuffix} failed: ${res.status} ${await res.text()}`,
        );
    }
    return (await res.json()) as T;
}

async function fetchGroupTypeIndex(
    host: string,
    projectId: string,
    apiKey: string,
    groupType: string,
): Promise<number | null> {
    const types = await postHogGet<PostHogGroupType[]>(
        host,
        projectId,
        apiKey,
        'groups_types/',
    );
    const match = types.find((t) => t.group_type === groupType);
    return match ? match.group_type_index : null;
}

/**
 * Registers the `repositoryDirectory` group type in PostHog (auto-created
 * on first groupIdentify) and tags each composite (repo, directory) pair
 * with metadata so it shows up properly in the PostHog group analytics
 * UI. Idempotent — re-running just refreshes the properties.
 */
async function registerRepositoryDirectoryGroups(
    apiKey: string,
    host: string,
    organizationId: string,
    pairs: RepositoryDirectoryPair[],
): Promise<void> {
    const posthog = new PostHog(apiKey, { host });
    for (const pair of pairs) {
        posthog.groupIdentify({
            groupType: GROUP_TYPE,
            groupKey: pair.compositeKey,
            properties: {
                organizationId,
                repositoryId: pair.repositoryId,
                directoryId: pair.directoryId,
            },
        });
    }
    await posthog.shutdown();
}

/**
 * Polls the group-types endpoint until the type appears (PostHog ingest
 * is asynchronous after groupIdentify). Returns the index once visible.
 */
async function waitForGroupTypeIndex(
    host: string,
    projectId: string,
    apiKey: string,
    groupType: string,
    timeoutMs = 60_000,
    intervalMs = 2_000,
): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const index = await fetchGroupTypeIndex(
            host,
            projectId,
            apiKey,
            groupType,
        );
        if (index !== null) return index;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(
        `Timed out waiting for PostHog group type "${groupType}" to appear after registration.`,
    );
}

async function fetchFlagByKey(
    host: string,
    projectId: string,
    apiKey: string,
    key: string,
): Promise<PostHogFlag> {
    const page = await postHogGet<{ results: PostHogFlag[] }>(
        host,
        projectId,
        apiKey,
        `feature_flags/?search=${encodeURIComponent(key)}`,
    );
    const flag = page.results.find((f) => f.key === key);
    if (!flag) throw new Error(`PostHog flag "${key}" not found`);
    return flag;
}

/**
 * Replaces the flag's filters with a single repositoryDirectory-aggregated
 * opt-out condition. PostHog rejects mixed aggregation types across
 * condition sets (`Mixed aggregation types across condition sets are
 * not yet supported`), so we wipe whatever's there and set the flag to
 * be fully repositoryDirectory-aggregated. The single resulting condition
 * matches `$group_key NOT in compositeKeys` at 100% rollout — every
 * composite key in the opt-out list returns false, everything else
 * returns true.
 */
function buildDirectoryOptoutFlag(
    flag: PostHogFlag,
    groupTypeIndex: number,
    compositeKeys: string[],
): PostHogFlag {
    const updated = JSON.parse(JSON.stringify(flag)) as PostHogFlag;
    updated.aggregation_group_type_index = groupTypeIndex;
    updated.filters.groups = [
        {
            properties: [
                {
                    key: '$group_key',
                    value: [...compositeKeys],
                    operator: 'is_not',
                    type: 'group',
                    group_type_index: groupTypeIndex,
                },
            ],
            rollout_percentage: 100,
            // PostHog reads the "condition set's group type" from this
            // per-condition field — it must match every property's
            // `group_type_index` AND the flag-level aggregation, or the
            // PATCH is rejected as "group properties must match the
            // condition set's group type".
            aggregation_group_type_index: groupTypeIndex,
        },
    ];
    return updated;
}

async function patchFlag(
    host: string,
    projectId: string,
    apiKey: string,
    flag: PostHogFlag,
): Promise<void> {
    const res = await fetch(
        `${host}/api/projects/${projectId}/feature_flags/${flag.id}/`,
        {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                filters: flag.filters,
                aggregation_group_type_index: flag.aggregation_group_type_index,
            }),
        },
    );
    if (!res.ok) {
        throw new Error(
            `PostHog PATCH failed: ${res.status} ${await res.text()}`,
        );
    }
}

async function main(): Promise<void> {
    loadEnv();

    if (!ORG_ID || ORG_ID.startsWith('<')) {
        throw new Error('Edit ORG_ID at the top of the script first');
    }

    const pgHost = requireEnv('API_PG_DB_HOST');
    const pgPort = Number(process.env.API_PG_DB_PORT ?? 5432);
    const pgUser = requireEnv('API_PG_DB_USERNAME');
    const pgPass = requireEnv('API_PG_DB_PASSWORD');
    const pgDb = requireEnv('API_PG_DB_DATABASE');
    const phProjectKey = requireEnv('API_POSTHOG_KEY');
    const phApiKey = requireEnv('POSTHOG_PERSONAL_API_KEY');
    const phProjectId = requireEnv('POSTHOG_PROJECT_ID');
    const phHost = process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com';

    console.log(
        `[script] org=${ORG_ID} flag=${FLAG_KEY} group=${GROUP_TYPE} apply=${APPLY}`,
    );

    const pg = new Client({
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
    await pg.connect();

    let pairs: RepositoryDirectoryPair[];
    try {
        pairs = await fetchRepositoryDirectoryPairsForOrg(pg, ORG_ID);
    } finally {
        await pg.end();
    }

    if (pairs.length === 0) {
        console.log(
            `[script] no (repository, directory) pairs found for org ${ORG_ID}`,
        );
        return;
    }
    console.log(
        `[script] found ${pairs.length} (repository, directory) pair(s) for org ${ORG_ID}`,
    );
    for (const pair of pairs) {
        console.log(`[script]   ${pair.compositeKey}`);
    }

    // Ensure the `repositoryDirectory` group type exists. PostHog
    // auto-creates it on first groupIdentify, so we always register
    // before reading the index — idempotent and also tags each
    // composite (repo, directory) instance with org metadata.
    if (APPLY) {
        console.log(
            `[script] registering ${pairs.length} ${GROUP_TYPE} group(s) in PostHog`,
        );
        await registerRepositoryDirectoryGroups(
            phProjectKey,
            phHost,
            ORG_ID,
            pairs,
        );
    } else {
        console.log(
            `[script] DRY RUN — skipping ${GROUP_TYPE} group registration`,
        );
    }

    const groupTypeIndex = APPLY
        ? await waitForGroupTypeIndex(phHost, phProjectId, phApiKey, GROUP_TYPE)
        : ((await fetchGroupTypeIndex(
              phHost,
              phProjectId,
              phApiKey,
              GROUP_TYPE,
          )) ?? -1); // dry-run with no group type yet: surface -1 to make output obvious

    if (groupTypeIndex < 0) {
        console.log(
            `[script] (dry-run) PostHog group type "${GROUP_TYPE}" does not exist yet — it will be created on apply. Showing flag merge with placeholder group_type_index=-1.`,
        );
    }

    const flag = await fetchFlagByKey(phHost, phProjectId, phApiKey, FLAG_KEY);
    const previousAggregation = flag.aggregation_group_type_index ?? null;
    const updated = buildDirectoryOptoutFlag(
        flag,
        groupTypeIndex,
        pairs.map((p) => p.compositeKey),
    );

    if (previousAggregation !== groupTypeIndex) {
        console.log(
            `[script] ⚠️  flag aggregation_group_type_index ${previousAggregation} → ${groupTypeIndex} — flag becomes per-${GROUP_TYPE}. The existing condition set will be REPLACED (PostHog does not allow mixed aggregation across condition sets).`,
        );
    }
    console.log(
        `[script] replacing flag filters with ${pairs.length} ${GROUP_TYPE} opt-out key(s)`,
    );

    if (!APPLY) {
        console.log('[script] DRY RUN — set APPLY = true to write changes.');
        console.log(
            `[script] resulting aggregation_group_type_index: ${updated.aggregation_group_type_index}`,
        );
        console.log('[script] resulting filters.groups:');
        console.log(JSON.stringify(updated.filters.groups, null, 2));
        return;
    }

    await patchFlag(phHost, phProjectId, phApiKey, updated);
    console.log(`[script] patched flag "${FLAG_KEY}" (id=${flag.id})`);
}

main().catch((err) => {
    console.error('[script] failed:', err);
    process.exit(1);
});
