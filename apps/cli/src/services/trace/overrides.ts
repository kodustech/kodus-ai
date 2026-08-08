import fs from 'node:fs/promises';
import path from 'node:path';
import { overridesPath } from './store-paths.js';
import type { TraceOverrides } from '../../types/trace.js';

const EMPTY: TraceOverrides = { forgotten: [], pinned: [] };

/**
 * Human corrections applied on top of whatever the model produced. This is the
 * curation layer — there is no separate curated-markdown store to keep in sync.
 */
export async function readOverrides(gitRoot: string): Promise<TraceOverrides> {
    try {
        const raw = await fs.readFile(overridesPath(gitRoot), 'utf-8');
        const parsed = JSON.parse(raw) as Partial<TraceOverrides>;
        return {
            forgotten: normalize(parsed.forgotten),
            pinned: normalize(parsed.pinned),
        };
    } catch {
        return { ...EMPTY };
    }
}

async function writeOverrides(
    gitRoot: string,
    overrides: TraceOverrides,
): Promise<void> {
    const filePath = overridesPath(gitRoot);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
        filePath,
        `${JSON.stringify(overrides, null, 2)}\n`,
        'utf-8',
    );
}

export async function forgetDecision(
    gitRoot: string,
    decisionId: string,
): Promise<TraceOverrides> {
    const overrides = await readOverrides(gitRoot);
    if (!overrides.forgotten.includes(decisionId)) {
        overrides.forgotten.push(decisionId);
        overrides.forgotten.sort();
    }
    // A forgotten decision cannot also be pinned.
    overrides.pinned = overrides.pinned.filter((id) => id !== decisionId);
    await writeOverrides(gitRoot, overrides);
    return overrides;
}

export async function pinDecision(
    gitRoot: string,
    decisionId: string,
): Promise<TraceOverrides> {
    const overrides = await readOverrides(gitRoot);
    if (!overrides.pinned.includes(decisionId)) {
        overrides.pinned.push(decisionId);
        overrides.pinned.sort();
    }
    overrides.forgotten = overrides.forgotten.filter((id) => id !== decisionId);
    await writeOverrides(gitRoot, overrides);
    return overrides;
}

export async function unpinDecision(
    gitRoot: string,
    decisionId: string,
): Promise<TraceOverrides> {
    const overrides = await readOverrides(gitRoot);
    overrides.pinned = overrides.pinned.filter((id) => id !== decisionId);
    await writeOverrides(gitRoot, overrides);
    return overrides;
}

function normalize(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return [
        ...new Set(
            value.filter((entry): entry is string => typeof entry === 'string'),
        ),
    ].sort();
}
