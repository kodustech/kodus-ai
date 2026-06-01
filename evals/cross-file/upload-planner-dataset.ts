#!/usr/bin/env npx ts-node

/**
 * Upload local planner eval dataset (JSONL) to Langfuse.
 *
 * Usage:
 *   npx ts-node evals/cross-file/upload-planner-dataset.ts --env=.env.prod --dataset-name="planner-eval-v2"
 *   npx ts-node evals/cross-file/upload-planner-dataset.ts --env=.env.prod --dataset-name="planner-eval-v2" --replace
 *   npx ts-node evals/cross-file/upload-planner-dataset.ts --dry-run
 *
 * Flags:
 *   --env=<path>            Path to .env file (default: auto from DOTENV_CONFIG_PATH)
 *   --dry-run               Validate JSONL without uploading
 *   --dataset-name=<name>   Create (or reuse) a dataset with this name
 *   --replace               Delete all existing items in the dataset before uploading
 *   --file=<path>           Path to JSONL file (default: evals/cross-file/datasets/planner-eval.jsonl)
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { LangfuseClient } from '@langfuse/client';
import { Logger } from '@nestjs/common';

// ─── CLI Args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(prefix: string): string | undefined {
    const match = args.find((a) => a.startsWith(`--${prefix}=`));
    return match ? match.split('=').slice(1).join('=') : undefined;
}

const envPath = getArg('env') ?? process.env.DOTENV_CONFIG_PATH;
if (envPath) {
    dotenv.config({ path: envPath });
} else {
    dotenv.config();
}

const dryRun = args.includes('--dry-run');
const replace = args.includes('--replace');
const datasetName = getArg('dataset-name');
const filePath =
    getArg('file') ?? 'evals/cross-file/datasets/planner-eval.jsonl';

// ─── Validation ────────────────────────────────────────────────────────────────

const logger = new Logger('UploadPlannerDataset');

if (
    !dryRun &&
    (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY)
) {
    throw new Error(
        'Missing LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY. Pass --env=<path> or set the env vars.',
    );
}

if (!dryRun && !datasetName) {
    throw new Error('Provide --dataset-name=<name>.');
}

// ─── Parse JSONL ───────────────────────────────────────────────────────────────

interface DatasetExample {
    inputs: {
        changedFiles: Array<{ filename: string; patch: string }>;
        changedFilenames: string[];
    };
    outputs: {
        expectedSymbols: string[];
        expectedUpstreamSymbols?: string[];
        expectedRiskLevels: Record<string, string>;
        knownConsumerFiles?: string[];
    };
}

function parseJsonlFile(filepath: string): DatasetExample[] {
    const resolved = path.resolve(filepath);
    if (!fs.existsSync(resolved)) {
        throw new Error(`File not found: ${resolved}`);
    }

    const content = fs.readFileSync(resolved, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    const examples: DatasetExample[] = [];

    for (let i = 0; i < lines.length; i++) {
        try {
            const parsed = JSON.parse(lines[i]) as DatasetExample;

            if (
                !parsed.inputs?.changedFiles ||
                !Array.isArray(parsed.inputs.changedFiles)
            ) {
                throw new Error('Missing or invalid inputs.changedFiles');
            }
            if (
                !parsed.inputs?.changedFilenames ||
                !Array.isArray(parsed.inputs.changedFilenames)
            ) {
                throw new Error('Missing or invalid inputs.changedFilenames');
            }
            if (
                !parsed.outputs?.expectedSymbols ||
                !Array.isArray(parsed.outputs.expectedSymbols)
            ) {
                throw new Error('Missing or invalid outputs.expectedSymbols');
            }

            examples.push(parsed);
        } catch (err) {
            throw new Error(
                `Failed to parse line ${i + 1}: ${(err as Error).message}`,
            );
        }
    }

    return examples;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    logger.log(`Parsing JSONL from ${filePath}...`);
    const examples = parseJsonlFile(filePath);
    logger.log(`Parsed ${examples.length} examples.`);

    for (let i = 0; i < examples.length; i++) {
        const ex = examples[i];
        const files = ex.inputs.changedFilenames.join(', ');
        const symbols =
            ex.outputs.expectedSymbols.join(', ') || '(none)';
        const upstream =
            (ex.outputs.expectedUpstreamSymbols ?? []).join(', ') || '(none)';
        logger.log(
            `  [${i + 1}] files=[${files}] symbols=[${symbols}] upstream=[${upstream}]`,
        );
    }

    if (dryRun) {
        logger.log('Dry run complete. All examples are valid.');
        return;
    }

    const client = new LangfuseClient();

    // Upsert dataset (Langfuse createDataset is idempotent by name)
    logger.log(`Ensuring dataset "${datasetName}"...`);
    await client.api.datasets.create({
        name: datasetName!,
        description: `Planner eval dataset uploaded from ${filePath}`,
    });

    if (replace) {
        logger.log(
            'NOTE: --replace was requested but Langfuse does not expose bulk delete via the public SDK. Re-upload will create new items alongside existing ones — delete stale items from the UI if needed.',
        );
    }

    logger.log(`Uploading ${examples.length} items...`);
    for (const ex of examples) {
        await client.api.datasetItems.create({
            datasetName: datasetName!,
            input: ex.inputs,
            expectedOutput: ex.outputs,
        });
    }

    logger.log(
        `Uploaded ${examples.length} items to dataset "${datasetName}".`,
    );
}

main().catch((error) => {
    logger.error('Upload failed', error as Error);
    process.exitCode = 1;
});
