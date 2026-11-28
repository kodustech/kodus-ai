import type { FileDiff } from '../types/cli.js';
import { parseGitNameStatusOutput } from './git-status.js';

export function listFilesFromNameStatus(nameStatus: string): string[] {
    return parseGitNameStatusOutput(nameStatus).map((entry) => entry.file);
}

export function buildFileStatusMap(
    nameStatus: string,
): Map<string, FileDiff['status']> {
    return new Map(
        parseGitNameStatusOutput(nameStatus).map((entry) => [
            entry.file,
            entry.status,
        ]),
    );
}

export function buildFileRenameSourceMap(
    nameStatus: string,
): Map<string, string> {
    const renameMap = new Map<string, string>();
    for (const entry of parseGitNameStatusOutput(nameStatus)) {
        if (entry.oldFile) {
            renameMap.set(entry.file, entry.oldFile);
        }
    }
    return renameMap;
}
