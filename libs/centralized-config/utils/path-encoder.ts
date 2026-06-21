export const GROUP_PATH_JOINER = '&';

export class InvalidGroupPathError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidGroupPathError';
    }
}

function normalize(path: string): string {
    return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

export function encodePathSegment(decoded: string): string {
    if (typeof decoded !== 'string') {
        throw new InvalidGroupPathError('Path must be a string');
    }
    const normalized = normalize(decoded.trim());
    if (!normalized) {
        throw new InvalidGroupPathError(
            'Path cannot be empty, whitespace, or the repository root',
        );
    }
    return normalized.replace(/%/g, '%25').replace(/\//g, '%2F');
}

export function decodePathSegment(encoded: string): string {
    // Single left-to-right pass so a decoded `%` cannot start another escape.
    return encoded.replace(/%(25|2F)/g, (_, code) =>
        code === '25' ? '%' : '/',
    );
}

export function validateGroupPaths(paths: string[]): void {
    if (!Array.isArray(paths) || paths.length === 0) {
        throw new InvalidGroupPathError('Group must have at least one path');
    }
    const seen = new Set<string>();
    for (const raw of paths) {
        if (typeof raw !== 'string') {
            throw new InvalidGroupPathError('Path must be a string');
        }
        const normalized = normalize(raw.trim());
        if (!normalized) {
            throw new InvalidGroupPathError(
                'Path cannot be empty, whitespace, or the repository root',
            );
        }
        if (seen.has(normalized)) {
            throw new InvalidGroupPathError(
                `Duplicate path in group: ${normalized}`,
            );
        }
        seen.add(normalized);
    }
}

export function buildGroupFolderName(paths: string[]): string {
    validateGroupPaths(paths);
    const normalized = paths
        .map((p) => normalize(p.trim()))
        .sort();
    return normalized.map(encodePathSegment).join(GROUP_PATH_JOINER);
}

export function parseGroupFolderName(folderName: string): string[] | null {
    if (typeof folderName !== 'string' || folderName.length === 0) {
        return null;
    }
    const segments = folderName.split(GROUP_PATH_JOINER);
    try {
        const decoded = segments.map((seg) => normalize(decodePathSegment(seg)));
        validateGroupPaths(decoded);
        return [...decoded].sort();
    } catch {
        return null;
    }
}
