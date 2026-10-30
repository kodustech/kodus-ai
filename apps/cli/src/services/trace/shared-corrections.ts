import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { TraceBranchRecord } from '../../types/trace.js';
import {
    pushTraceBranch,
    readAllBranchRecords,
    writeBranchRecord,
} from './decision-branch.service.js';
import {
    readAllLocalBranchRecords,
    saveLocalBranchRecord,
} from './local-decisions.js';
import { applyRecordCorrections } from './record-corrections.js';

export type SharedCorrectionAction = 'forget' | 'pin' | 'unpin';

export interface SharedCorrectionResult {
    found: boolean;
    pushed: boolean;
    pushError?: string;
}

/**
 * Persist a correction in every branch shard that contains the stable decision
 * id. Decisions normally belong to one shard, but merges and older clients can
 * copy them into another; updating every copy keeps a forgotten decision from
 * resurfacing in review. The local Trace ref is updated even when offline.
 */
export async function updateSharedDecisionCorrection(
    gitRoot: string,
    decisionId: string,
    action: SharedCorrectionAction,
    remote?: string,
): Promise<SharedCorrectionResult> {
    const selectedRemote = remote ?? (await resolveRemote(gitRoot));
    const [local, shared] = await Promise.all([
        readAllLocalBranchRecords(gitRoot),
        readAllBranchRecords(gitRoot, selectedRemote).catch(() => []),
    ]);

    // Local records are appended last so an offline/newer local shard wins over
    // a stale copy fetched from the shared ref for the same branch.
    const records = findOwningRecords([...shared, ...local], decisionId);
    if (records.length === 0) {
        return { found: false, pushed: false };
    }

    const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'kodus-trace-correction-index-'),
    );
    try {
        let pushed = !!selectedRemote;
        let pushError: string | undefined;

        for (const [index, record] of records.entries()) {
            const updated = updateRecord(record, decisionId, action);
            await saveLocalBranchRecord(gitRoot, updated);

            const indexFile = path.join(tempDir, `index-${index}`);
            const written = await writeBranchRecord(gitRoot, updated, {
                indexFile,
            });
            if (!selectedRemote) {
                pushed = false;
                continue;
            }

            const outcome = await pushTraceBranch(gitRoot, updated, {
                remote: selectedRemote,
                indexFile,
                sourceCommit: written.commit,
                mergeRemoteDecisions: true,
            });
            if (!outcome.pushed) {
                pushed = false;
                pushError ??= outcome.error;
            }
        }

        return {
            found: true,
            pushed,
            pushError,
        };
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}

function findOwningRecords(
    records: TraceBranchRecord[],
    decisionId: string,
): TraceBranchRecord[] {
    const byBranch = new Map<string, TraceBranchRecord>();

    for (const record of records) {
        if (record.decisions?.some((decision) => decision.id === decisionId)) {
            byBranch.set(record.branch, record);
        }
    }

    if (byBranch.size > 0) {
        return [...byBranch.values()];
    }

    for (const record of records) {
        if (
            record.corrections?.forgotten?.includes(decisionId) ||
            record.corrections?.pinned?.includes(decisionId)
        ) {
            byBranch.set(record.branch, record);
        }
    }

    return [...byBranch.values()];
}

function updateRecord(
    record: TraceBranchRecord,
    decisionId: string,
    action: SharedCorrectionAction,
): TraceBranchRecord {
    const forgotten = new Set(record.corrections?.forgotten ?? []);
    const pinned = new Set(record.corrections?.pinned ?? []);

    if (action === 'forget') {
        forgotten.add(decisionId);
        pinned.delete(decisionId);
    } else if (action === 'pin') {
        pinned.add(decisionId);
        forgotten.delete(decisionId);
    } else {
        pinned.delete(decisionId);
    }

    return applyRecordCorrections({
        ...record,
        updatedAt: new Date().toISOString(),
        corrections: {
            forgotten: [...forgotten].sort(),
            pinned: [...pinned].sort(),
        },
    });
}

async function resolveRemote(gitRoot: string): Promise<string | undefined> {
    try {
        const { stdout } = await execa('git', ['remote'], { cwd: gitRoot });
        const remotes = stdout
            .split('\n')
            .map((entry) => entry.trim())
            .filter(Boolean);
        return remotes.includes('origin') ? 'origin' : remotes[0];
    } catch {
        return undefined;
    }
}
