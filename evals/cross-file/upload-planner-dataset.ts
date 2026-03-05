#!/usr/bin/env npx ts-node

/**
 * Upload local planner eval dataset (JSONL) to LangSmith.
 *
 * Usage:
 *   npx ts-node evals/cross-file/upload-planner-dataset.ts --env=.env.prod --dataset-name="planner-eval-v2"
 *   npx ts-node evals/cross-file/upload-planner-dataset.ts --env=.env.prod --dataset-id=<uuid> --replace
 *   npx ts-node evals/cross-file/upload-planner-dataset.ts --dry-run
 *
 * Flags:
 *   --env=<path>            Path to .env file (default: auto from DOTENV_CONFIG_PATH)
 *   --dry-run               Validate JSONL without uploading
 *   --dataset-name=<name>   Create a new dataset with this name
 *   --dataset-id=<uuid>     Use existing dataset by UUID
 *   --replace               Delete all existing examples before uploading (requires --dataset-id)
 *   --file=<path>           Path to JSONL file (default: evals/cross-file/datasets/planner-eval.jsonl)
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'langsmith';
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
const datasetId = getArg('dataset-id');
const filePath = getArg('file') ?? 'evals/cross-file/datasets/planner-eval.jsonl';

// ─── Validation ────────────────────────────────────────────────────────────────

const logger = new Logger('UploadPlannerDataset');

if (!dryRun && !process.env.LANGCHAIN_API_KEY && !process.env.LANGSMITH_API_KEY) {
    throw new Error('Missing LANGCHAIN_API_KEY or LANGSMITH_API_KEY. Pass --env=<path> or set the env var.');
}

if (!dryRun && !datasetName && !datasetId) {
    throw new Error('Provide --dataset-name=<name> (to create) or --dataset-id=<uuid> (to use existing).');
}

if (replace && !datasetId) {
    throw new Error('--replace requires --dataset-id=<uuid>.');
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

            // Validate required fields
            if (!parsed.inputs?.changedFiles || !Array.isArray(parsed.inputs.changedFiles)) {
                throw new Error('Missing or invalid inputs.changedFiles');
            }
            if (!parsed.inputs?.changedFilenames || !Array.isArray(parsed.inputs.changedFilenames)) {
                throw new Error('Missing or invalid inputs.changedFilenames');
            }
            if (!parsed.outputs?.expectedSymbols || !Array.isArray(parsed.outputs.expectedSymbols)) {
                throw new Error('Missing or invalid outputs.expectedSymbols');
            }

            examples.push(parsed);
        } catch (err) {
            throw new Error(`Failed to parse line ${i + 1}: ${(err as Error).message}`);
        }
    }

    return examples;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    logger.log(`Parsing JSONL from ${filePath}...`);
    const examples = parseJsonlFile(filePath);
    logger.log(`Parsed ${examples.length} examples.`);

    // Summary
    for (let i = 0; i < examples.length; i++) {
        const ex = examples[i];
        const files = ex.inputs.changedFilenames.join(', ');
        const symbols = ex.outputs.expectedSymbols.join(', ') || '(none)';
        const upstream = (ex.outputs.expectedUpstreamSymbols ?? []).join(', ') || '(none)';
        logger.log(`  [${i + 1}] files=[${files}] symbols=[${symbols}] upstream=[${upstream}]`);
    }

    if (dryRun) {
        logger.log('Dry run complete. All examples are valid.');
        return;
    }

    const client = new Client();

    // Resolve or create dataset
    let targetDatasetId: string;

    if (datasetId) {
        targetDatasetId = datasetId;
        logger.log(`Using existing dataset: ${datasetId}`);
    } else {
        logger.log(`Creating new dataset: "${datasetName}"...`);
        const dataset = await client.createDataset(datasetName!, {
            description: `Planner eval dataset uploaded from ${filePath}`,
            dataType: 'kv',
        });
        targetDatasetId = dataset.id;
        logger.log(`Created dataset: ${dataset.id}`);
    }

    // Replace existing examples if requested
    if (replace) {
        logger.log('Deleting existing examples (--replace)...');
        const existingIds: string[] = [];
        for await (const example of client.listExamples({ datasetId: targetDatasetId })) {
            existingIds.push(example.id);
        }
        if (existingIds.length > 0) {
            await client.deleteExamples(existingIds);
            logger.log(`Deleted ${existingIds.length} existing examples.`);
        } else {
            logger.log('No existing examples to delete.');
        }
    }

    // Upload examples
    logger.log(`Uploading ${examples.length} examples...`);
    await client.createExamples({
        inputs: examples.map((ex) => ex.inputs),
        outputs: examples.map((ex) => ex.outputs),
        datasetId: targetDatasetId,
    });

    logger.log(`Successfully uploaded ${examples.length} examples to dataset ${targetDatasetId}.`);
}

main().catch((error) => {
    logger.error('Upload failed', error as Error);
    process.exitCode = 1;
});
