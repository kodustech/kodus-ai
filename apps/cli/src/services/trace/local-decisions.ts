import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { localDecisionsDir } from './store-paths.js';
import type { TraceBranchRecord } from '../../types/trace.js';

function fileNameForBranch(branchName: string): string {
    const hash = crypto
        .createHash('sha256')
        .update(branchName)
        .digest('hex')
        .slice(0, 16);
    return `${hash}.json`;
}

/**
 * Distillation writes the branch record locally as well as onto the orphan
 * branch, so recall answers from the machine that produced the sessions even
 * before anything is pushed — and with no network access at all.
 */
export async function saveLocalBranchRecord(
    gitRoot: string,
    record: TraceBranchRecord,
): Promise<string> {
    const dir = localDecisionsDir(gitRoot);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, fileNameForBranch(record.branch));
    await fs.writeFile(
        filePath,
        `${JSON.stringify(record, null, 2)}\n`,
        'utf-8',
    );
    return filePath;
}

export async function readLocalBranchRecord(
    gitRoot: string,
    branchName: string,
): Promise<TraceBranchRecord | null> {
    const filePath = path.join(
        localDecisionsDir(gitRoot),
        fileNameForBranch(branchName),
    );
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(raw) as TraceBranchRecord;
    } catch {
        return null;
    }
}

export async function readAllLocalBranchRecords(
    gitRoot: string,
): Promise<TraceBranchRecord[]> {
    const dir = localDecisionsDir(gitRoot);
    let entries: string[];
    try {
        entries = await fs.readdir(dir);
    } catch {
        return [];
    }

    const records = await Promise.all(
        entries
            .filter((entry) => entry.endsWith('.json'))
            .map(async (entry) => {
                try {
                    const raw = await fs.readFile(
                        path.join(dir, entry),
                        'utf-8',
                    );
                    return JSON.parse(raw) as TraceBranchRecord;
                } catch {
                    return null;
                }
            }),
    );

    return records.filter((record): record is TraceBranchRecord => !!record);
}
