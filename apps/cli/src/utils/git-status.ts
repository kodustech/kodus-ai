import type { FileDiff } from '../types/cli.js';

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

export type GitNameStatusEntry = {
    file: string;
    status: FileDiff['status'];
    oldFile?: string;
};

export function parseGitNameStatusOutput(
    nameStatus: string,
): GitNameStatusEntry[] {
    const files: GitNameStatusEntry[] = [];

    if (nameStatus.includes('\0')) {
        const tokens = nameStatus.split('\0');
        for (let i = 0; i < tokens.length;) {
            const statusChar = tokens[i++];
            if (!statusChar) {
                continue;
            }
            const isRename = statusChar.startsWith('R');
            const isCopy = statusChar.startsWith('C');
            const oldFile = isRename || isCopy ? tokens[i++] : undefined;
            const fileName = tokens[i++];
            if (!fileName) {
                continue;
            }
            files.push({
                file: fileName,
                status: parseGitStatus(statusChar),
                ...(isRename && oldFile ? { oldFile } : {}),
            });
        }
        return files;
    }

    for (const line of nameStatus.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        const parts = trimmed.split('\t');
        const statusChar = parts[0];
        const isRename = statusChar.startsWith('R');
        const isCopy = statusChar.startsWith('C');
        const oldFile = isRename || isCopy ? parts[1] : undefined;
        const fileName =
            isRename || isCopy ? parts[parts.length - 1] : parts[1];

        if (!fileName) {
            continue;
        }

        files.push({
            file: fileName,
            status: parseGitStatus(statusChar),
            ...(isRename && oldFile ? { oldFile } : {}),
        });
    }

    return files;
}
