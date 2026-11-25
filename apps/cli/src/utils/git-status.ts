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

export function parseGitNameStatusOutput(
    nameStatus: string,
): Array<{ file: string; status: FileDiff['status'] }> {
    const files: Array<{ file: string; status: FileDiff['status'] }> = [];

    if (nameStatus.includes('\0')) {
        const tokens = nameStatus.split('\0');
        for (let i = 0; i < tokens.length;) {
            const statusChar = tokens[i++];
            if (!statusChar) {
                continue;
            }
            const isRenameOrCopy =
                statusChar.startsWith('R') || statusChar.startsWith('C');
            const fileName = isRenameOrCopy ? (i++, tokens[i++]) : tokens[i++];
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
