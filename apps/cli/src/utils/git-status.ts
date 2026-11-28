import type { FileDiff } from '../types/cli.js';

export type TrackedGitStatus = {
    staged: string[];
    modified: string[];
};

const unmergedStatuses = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

export function parseTrackedGitStatus(status: string): TrackedGitStatus {
    const result: TrackedGitStatus = { staged: [], modified: [] };
    const entries = status.split('\0');

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.length < 4 || entry.charAt(2) !== ' ') {
            continue;
        }

        const index = entry.charAt(0);
        const workingDir = entry.charAt(1);
        const file = entry.slice(3);

        if (unmergedStatuses.has(`${index}${workingDir}`)) {
            continue;
        }
        if (
            index === 'R' ||
            index === 'C' ||
            workingDir === 'R' ||
            workingDir === 'C'
        ) {
            i++;
        }

        if (index === 'A' || index === 'D' || index === 'M') {
            result.staged.push(file);
        }
        if (index === 'M' || workingDir === 'M') {
            result.modified.push(file);
        }
    }

    return result;
}

export function parseGitStatus(statusChar: string): FileDiff['status'] {
    const char = statusChar.charAt(0).toUpperCase();
    switch (char) {
        case 'A':
            return 'added';
        case 'D':
            return 'deleted';
        case 'R':
            return 'renamed';
        default:
            return 'modified';
    }
}

export function parseGitNameStatusOutput(
    nameStatus: string,
): Array<{ file: string; status: FileDiff['status'] }> {
    const files: Array<{ file: string; status: FileDiff['status'] }> = [];

    for (const line of nameStatus.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        const parts = trimmed.split('\t');
        const statusChar = parts[0];
        const fileName =
            statusChar.startsWith('R') || statusChar.startsWith('C')
                ? parts[parts.length - 1]
                : parts[1];

        if (!fileName) {
            continue;
        }

        files.push({
            file: fileName,
            status: parseGitStatus(statusChar),
        });
    }

    return files;
}
