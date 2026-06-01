#!/usr/bin/env npx ts-node
/**
 * Sets the release track on one organization (or many, via --all-stable
 * style flags later if needed) and mirrors the new value to the PostHog
 * `organization` group property in the same shot.
 *
 * Run by Kodus staff for the few customers that should diverge from the
 * default `beta` track — primarily `stable` for stability-pinned customers
 * (e.g. enterprise) and `internal` for the Kodus dogfood org.
 *
 * Usage:
 *   npx ts-node scripts/feature-gate/set-release-track.ts \
 *       --org-id=<uuid> --track=stable
 *
 *   # Dry-run (prints the SQL it would run, skips PostHog)
 *   npx ts-node scripts/feature-gate/set-release-track.ts \
 *       --org-id=<uuid> --track=beta --dry-run
 *
 *   # Use a specific .env file (defaults to .env)
 *   npx ts-node scripts/feature-gate/set-release-track.ts \
 *       --org-id=<uuid> --track=internal --env=.env.prod
 *
 * Env vars required:
 *   API_POSTHOG_KEY                                                (cloud only — skipped when missing)
 *   API_PG_DB_HOST, API_PG_DB_PORT, API_PG_DB_USERNAME,
 *   API_PG_DB_PASSWORD, API_PG_DB_DATABASE
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { Client } from 'pg';
import { PostHog } from 'posthog-node';

const VALID_TRACKS = ['stable', 'beta', 'alpha'] as const;
type Track = (typeof VALID_TRACKS)[number];

interface Options {
    orgId: string;
    track: Track;
    dryRun: boolean;
    envFile: string;
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
    const track = get('--track');
    const dryRun = args.includes('--dry-run');
    const envFile = get('--env') ?? '.env';

    if (!orgId) {
        console.error('Missing required flag: --org-id=<uuid>');
        process.exit(2);
    }
    if (!track || !VALID_TRACKS.includes(track as Track)) {
        console.error(
            `Missing or invalid --track. Got "${track ?? '(none)'}". Expected one of: ${VALID_TRACKS.join(', ')}.`,
        );
        process.exit(2);
    }

    return { orgId, track: track as Track, dryRun, envFile };
}

async function updateDb(orgId: string, track: Track, dryRun: boolean): Promise<void> {
    const sql = `UPDATE organizations SET release_track = $1 WHERE uuid = $2`;
    if (dryRun) {
        console.log(`[dry-run] SQL: ${sql}`);
        console.log(`[dry-run] params: ['${track}', '${orgId}']`);
        return;
    }

    const client = new Client({
        host: process.env.API_PG_DB_HOST,
        port: Number(process.env.API_PG_DB_PORT ?? 5432),
        user: process.env.API_PG_DB_USERNAME,
        password: process.env.API_PG_DB_PASSWORD,
        database: process.env.API_PG_DB_DATABASE,
    });
    await client.connect();
    try {
        const result = await client.query(sql, [track, orgId]);
        if (result.rowCount === 0) {
            console.warn(
                `WARN: no row matched uuid=${orgId}. Did you copy the right id?`,
            );
            process.exit(1);
        }
        console.log(`Updated organizations.release_track for ${orgId} -> ${track}`);
    } finally {
        await client.end();
    }
}

async function mirrorToPosthog(
    orgId: string,
    track: Track,
    dryRun: boolean,
): Promise<void> {
    const apiKey = process.env.API_POSTHOG_KEY;
    if (!apiKey) {
        console.warn(
            'Skipping PostHog mirror — API_POSTHOG_KEY not set (expected on self-hosted).',
        );
        return;
    }
    if (dryRun) {
        console.log(
            `[dry-run] posthog.groupIdentify(organization, ${orgId}, { release_track: ${track} })`,
        );
        return;
    }

    const posthog = new PostHog(apiKey, { host: 'https://us.i.posthog.com' });
    try {
        posthog.groupIdentify({
            groupType: 'organization',
            groupKey: orgId,
            properties: { release_track: track },
        });
        await posthog.shutdown();
        console.log(
            `Mirrored to PostHog group property: organization/${orgId}.release_track = ${track}`,
        );
    } catch (err) {
        console.warn(
            `PostHog mirror failed: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

async function main(): Promise<void> {
    const { orgId, track, dryRun, envFile } = parseArgs();

    dotenv.config({ path: path.resolve(process.cwd(), envFile) });

    console.log(
        `Setting release_track for org ${orgId} -> ${track}${dryRun ? ' (dry-run)' : ''}`,
    );

    await updateDb(orgId, track, dryRun);
    await mirrorToPosthog(orgId, track, dryRun);

    console.log('Done.');
}

void main().catch((err: Error) => {
    console.error(err.stack ?? err.message);
    process.exit(1);
});
