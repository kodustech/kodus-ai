#!/usr/bin/env ts-node
/**
 * Smoke-tests the catalog gate against live DB state.
 *
 * Runs the same `evaluateCatalogGate` decision the backend's
 * `FeatureGateService` calls in production (covered by 19 unit tests
 * in `test/unit/feature-gate/feature-gate.service.spec.ts`), against
 * every (organization, feature) pair in the local Postgres. The goal
 * is to surface, in one table, what the API would answer for each
 * combination — so the operator can sanity-check before flipping
 * tracks or promoting features.
 *
 * Pure read; never writes to DB or PostHog.
 *
 * Usage:
 *   pnpm run feature-gate:check
 *
 * Env vars (read from `.env`, override via inline):
 *   API_PG_DB_HOST  defaults to 127.0.0.1 if .env contains the
 *                   container hostname `db_postgres`.
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { Client } from 'pg';

// `dotenv` must run BEFORE the environment module is imported, because
// the dev variant of environment.ts reads `process.env.API_CLOUD_MODE`
// at module-load time.
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
if (process.env.API_PG_DB_HOST === 'db_postgres') {
    process.env.API_PG_DB_HOST = '127.0.0.1';
}

import { environment } from '../../libs/ee/configs/environment/environment';
import { evaluateCatalogGate } from '../../libs/feature-gate/domain/decision';
import { loadSnapshot } from '../../libs/feature-gate/infrastructure/feature-snapshot.loader';

interface OrgRow {
    uuid: string;
    name: string;
    track: 'stable' | 'beta' | 'alpha';
}

async function listOrgs(): Promise<OrgRow[]> {
    const client = new Client({
        host: process.env.API_PG_DB_HOST,
        port: Number(process.env.API_PG_DB_PORT ?? 5432),
        user: process.env.API_PG_DB_USERNAME,
        password: process.env.API_PG_DB_PASSWORD,
        database: process.env.API_PG_DB_DATABASE,
    });
    await client.connect();
    try {
        const result = await client.query(
            `SELECT uuid, name, release_track FROM organizations ORDER BY name`,
        );
        return result.rows.map((r) => ({
            uuid: r.uuid,
            name: r.name,
            track: r.release_track,
        }));
    } finally {
        await client.end();
    }
}

const COLOR_RED = '\x1b[31m';
const COLOR_GREEN = '\x1b[32m';
const COLOR_DIM = '\x1b[2m';
const COLOR_RESET = '\x1b[0m';

function decisionLabel(decision: 'pass' | 'deny' | 'compat-pass'): string {
    if (decision === 'deny') return `${COLOR_RED}deny${COLOR_RESET}     `;
    if (decision === 'compat-pass')
        return `${COLOR_DIM}compat${COLOR_RESET}   `;
    return `${COLOR_GREEN}pass${COLOR_RESET}     `;
}

async function main(): Promise<void> {
    const orgs = await listOrgs();
    if (orgs.length === 0) {
        console.error('No organizations in the local DB.');
        process.exit(1);
    }

    const snapshot = loadSnapshot();
    const features = Object.entries(snapshot.features).map(([key, f]) => ({
        key,
        stage: f.stage,
        audience: f.audience ?? (['cloud', 'self-hosted'] as const),
        entry: f,
    }));

    // Read API_CLOUD_MODE through the canonical `environment` module so
    // we exercise the same lookup path the runtime uses. The value is
    // either resolved from `process.env` (dev variant) or baked at build
    // time (prod / self-hosted bundle).
    const audience = environment.API_CLOUD_MODE ? 'cloud' : 'self-hosted';
    const selfHostedBetaEnabled =
        process.env.BETA_FEATURES === 'true' ||
        process.env.BETA_FEATURES === '1';

    console.log('');
    console.log(
        `Backend mode: ${audience}` +
            (audience === 'self-hosted'
                ? ` (BETA_FEATURES=${selfHostedBetaEnabled ? 'on' : 'off'})`
                : ''),
    );
    console.log(
        `Catalog: ${features.length} feature(s) loaded from snapshot generated at ${snapshot.generated_at}`,
    );
    console.log('');
    console.log(
        '┌──────────────────────────────────────┬──────────┬───────────────────────────────┬─────────────────────────┬──────────┐',
    );
    console.log(
        '│ org                                  │ track    │ feature                       │ stage                   │ decision │',
    );
    console.log(
        '├──────────────────────────────────────┼──────────┼───────────────────────────────┼─────────────────────────┼──────────┤',
    );

    for (const org of orgs) {
        for (const feature of features) {
            const decision = evaluateCatalogGate({
                entry: feature.entry,
                audience,
                track: org.track,
                selfHostedBetaEnabled,
            });
            const orgLabel = org.name.padEnd(36).slice(0, 36);
            const trackLabel = org.track.padEnd(8);
            const featureLabel = feature.key.padEnd(29).slice(0, 29);
            const stageLabel = feature.stage.padEnd(23);
            console.log(
                `│ ${orgLabel} │ ${trackLabel} │ ${featureLabel} │ ${stageLabel} │ ${decisionLabel(decision)} │`,
            );
        }
    }
    console.log(
        '└──────────────────────────────────────┴──────────┴───────────────────────────────┴─────────────────────────┴──────────┘',
    );
    console.log('');
    console.log('Legend:');
    console.log(
        `  ${COLOR_GREEN}pass${COLOR_RESET}     catalog allows; backend will then call PostHog for the final flag value`,
    );
    console.log(
        `  ${COLOR_RED}deny${COLOR_RESET}     catalog blocks before PostHog (track too low for stage, or audience mismatch)`,
    );
    console.log(
        `  ${COLOR_DIM}compat${COLOR_RESET}   feature missing from catalog → permissive default (legacy behaviour)`,
    );
}

void main().catch((err: Error) => {
    console.error(err.stack ?? err.message);
    process.exit(1);
});
