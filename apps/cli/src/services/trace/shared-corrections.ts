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
 * Persist a correction in the branch shard that owns the stable decision id.
 * The local Trace ref is updated even when the remote is offline; the next
 * successful Trace push publishes it.
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

    const record = findOwningRecord([...local, ...shared], decisionId);
    if (!record) {
        return { found: false, pushed: false };
    }

    const updated = updateRecord(record, decisionId, action);
    await saveLocalBranchRecord(gitRoot, updated);

    const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'kodus-trace-correction-index-'),
    );
    const indexFile = path.join(tempDir, 'index');
    try {
        const written = await writeBranchRecord(gitRoot, updated, {
            indexFile,
        });
        if (!selectedRemote) {
            return { found: true, pushed: false };
        }
        const outcome = await pushTraceBranch(gitRoot, updated, {
            remote: selectedRemote,
            indexFile,
            sourceCommit: written.commit,
            mergeRemoteDecisions: true,
        });
        return {
            found: true,
            pushed: outcome.pushed,
            pushError: outcome.error,
        };
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}

function findOwningRecord(
    records: TraceBranchRecord[],
    decisionId: string,
): TraceBranchRecord | null {
    return (
        records.find((record) =>
            record.decisions?.some((decision) => decision.id === decisionId),
        ) ??
        records.find(
            (record) =>
                record.corrections?.forgotten?.includes(decisionId) ||
                record.corrections?.pinned?.includes(decisionId),
        ) ??
        null
    );
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
