import type { FileDiff } from '../types/cli.js';
import { buildFileStatusMap, listFilesFromNameStatus } from './git-file-targets.js';

export function createFileSelectionFromPaths(files: string[]): {
    filesToRead: string[];
    fileStatusMap: Map<string, FileDiff['status']>;
} {
    return {
        filesToRead: files,
        fileStatusMap: new Map(),
    };
}

export function createFileSelectionFromNameStatus(nameStatus: string): {
    filesToRead: string[];
    fileStatusMap: Map<string, FileDiff['status']>;
} {
    return {
        filesToRead: listFilesFromNameStatus(nameStatus),
        fileStatusMap: buildFileStatusMap(nameStatus),
    };
}

export function createFileSelectionFromModifiedFiles(
    files: FileDiff[],
): {
    filesToRead: string[];
    fileStatusMap: Map<string, FileDiff['status']>;
} {
    return {
        filesToRead: files.map((file) => file.file),
        fileStatusMap: new Map(files.map((file) => [file.file, file.status])),
    };
}
