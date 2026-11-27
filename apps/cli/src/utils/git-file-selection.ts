import type { FileDiff } from '../types/cli.js';
import {
    buildFileRenameSourceMap,
    buildFileStatusMap,
    listFilesFromNameStatus,
} from './git-file-targets.js';

export function createFileSelectionFromPaths(files: string[]): {
    filesToRead: string[];
    fileStatusMap: Map<string, FileDiff['status']>;
} {
    return {
        filesToRead: files,
        fileStatusMap: new Map(),
    };
}

export function createFileSelectionFromNameStatus(
    nameStatus: string,
    pathPrefix = '',
): {
    filesToRead: string[];
    fileStatusMap: Map<string, FileDiff['status']>;
    fileOldPathMap: Map<string, string>;
} {
    const normalizedPrefix =
        pathPrefix && !pathPrefix.endsWith('/') ? `${pathPrefix}/` : pathPrefix;
    const prefixPath = (filePath: string) => `${normalizedPrefix}${filePath}`;

    return {
        filesToRead: listFilesFromNameStatus(nameStatus).map(prefixPath),
        fileStatusMap: new Map(
            Array.from(buildFileStatusMap(nameStatus).entries()).map(
                ([file, status]) => [prefixPath(file), status],
            ),
        ),
        fileOldPathMap: new Map(
            Array.from(buildFileRenameSourceMap(nameStatus).entries()).map(
                ([file, oldFile]) => [prefixPath(file), prefixPath(oldFile)],
            ),
        ),
    };
}

export function createFileSelectionFromModifiedFiles(files: FileDiff[]): {
    filesToRead: string[];
    fileStatusMap: Map<string, FileDiff['status']>;
} {
    return {
        filesToRead: files.map((file) => file.file),
        fileStatusMap: new Map(files.map((file) => [file.file, file.status])),
    };
}
