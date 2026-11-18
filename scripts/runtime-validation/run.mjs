#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
    executePlan,
    inspectInventory,
    inventoryHash,
    parseArgs,
    selectPlan,
    validateInventory,
    ValidationError,
} from './harness.mjs';

let manifest = {
    version: 1,
    mode: 'plan',
    status: 'not_measured',
    selected: [],
    excluded: [],
};
try {
    const bytes = await readFile(new URL('./inventory.json', import.meta.url));
    const inventory = JSON.parse(bytes);
    validateInventory(inventory);
    const options = parseArgs(process.argv.slice(2), inventory);
    manifest = {
        ...selectPlan(inventory, options),
        inventorySha256: inventoryHash(bytes),
    };
    const root = fileURLToPath(new URL('../../', import.meta.url));
    await inspectInventory(root, inventory);
    manifest.runtime = {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
    };
    const hashes = async (paths) =>
        Object.fromEntries(
            await Promise.all(
                [...paths]
                    .sort()
                    .map(async (path) => [
                        path,
                        inventoryHash(await readFile(join(root, path))),
                    ]),
            ),
        );
    manifest.provenance = {
        scope: 'selected_tests_and_harness_only',
        productionGraph: 'not_attested',
        selectedTestSha256: await hashes(
            manifest.selected.map((entry) => entry.path),
        ),
        runnerSha256: await hashes([
            'scripts/runtime-validation/harness.mjs',
            'scripts/runtime-validation/run.mjs',
            'scripts/runtime-validation/inventory.json',
        ]),
    };
    if (options.run) {
        const result = await executePlan({ root, plan: manifest, options });
        manifest = result.manifest;
        process.exitCode = result.exitCode;
    }
} catch (error) {
    manifest.status = 'not_measured';
    manifest.reason =
        error instanceof ValidationError
            ? error.code
            : 'validation_setup_failed';
    if (Array.isArray(error?.unlisted)) manifest.unlisted = error.unlisted;
    process.exitCode = 2;
}
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
