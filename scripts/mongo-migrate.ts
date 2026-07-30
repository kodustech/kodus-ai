#!/usr/bin/env npx ts-node
/* eslint-disable no-console */

/**
 * Generic runner for MongoDB migration tasks — the manual / dry-run entry point.
 *
 * The BOOT path does NOT use this: each task is also a TypeORM migration that
 * runs automatically on deploy (recorded in the Postgres `migrations` ledger).
 * This CLI is only for running a task by hand — e.g. dry-running a data remap,
 * or backfilling a very large instance off-peak BEFORE deploying so the boot
 * migration is a no-op (all tasks are idempotent).
 *
 * ONE registry, so a new migration adds a single line here — never a new
 * package.json script.
 *
 * Usage:
 *   pnpm mongo:migrate <task> [--dry-run] [task-flags…]
 *   pnpm mongo:migrate token-usage-tu --indexes-only
 *   pnpm mongo:migrate kody-rules-origin --dry-run
 *   BATCH=5000 SLEEP_MS=100 SINCE=2026-01-01 pnpm mongo:migrate token-usage-tu
 *
 * Required env: API_MG_DB_* (or MONGODB_URI) — same Mongo connection as the API.
 */

import 'dotenv/config';

import { Db } from 'mongodb';

import { mongoMigrationClient } from '../libs/core/infrastructure/database/mongo/mongo-migration-client';
import { ensureTokenUsageIndexes } from '../libs/core/infrastructure/database/mongo/token-usage/ensure-indexes';
import { backfillTokenUsageTu } from '../libs/core/infrastructure/database/mongo/token-usage/backfill-tu';
import { migrateKodyRulesOriginRequestType } from '../libs/core/infrastructure/database/mongo/kody-rules/migrate-origin-request-type';

type TaskCtx = {
    db: Db;
    dryRun: boolean;
    argv: string[];
    log: (m: string) => void;
};

const num = (v: string | undefined, d: number) => (v ? parseInt(v, 10) : d);

// Register a task by name → its runner. Each runner reuses the SAME shared
// module the matching TypeORM migration calls, so CLI and boot stay in lockstep.
const TASKS: Record<string, (ctx: TaskCtx) => Promise<void>> = {
    'token-usage-tu': async ({ db, dryRun, argv, log }) => {
        const backfillOnly = argv.includes('--backfill-only');
        const indexesOnly = argv.includes('--indexes-only');
        if (!backfillOnly) await ensureTokenUsageIndexes(db, log);
        if (!indexesOnly) {
            await backfillTokenUsageTu(db, {
                batch: num(process.env.BATCH, 3000),
                sleepMs: num(process.env.SLEEP_MS, 150),
                since: process.env.SINCE ? new Date(process.env.SINCE) : null,
                dryRun,
                log,
            });
        }
    },
    'kody-rules-origin': async ({ db, dryRun, log }) => {
        await migrateKodyRulesOriginRequestType(db, { dryRun, log });
    },
};

async function main() {
    const argv = process.argv.slice(2);
    const task = argv.find((a) => !a.startsWith('-'));
    const dryRun = argv.includes('--dry-run');

    if (!task || !TASKS[task]) {
        console.error(
            `Usage: pnpm mongo:migrate <task> [--dry-run] [task-flags]\n` +
                `Tasks: ${Object.keys(TASKS).join(', ')}`,
        );
        process.exit(1);
    }

    const { db, close } = await mongoMigrationClient();
    try {
        await TASKS[task]({ db, dryRun, argv, log: (m) => console.log(m) });
    } finally {
        await close();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error('mongo-migrate crashed:', err);
        process.exit(1);
    });
}
