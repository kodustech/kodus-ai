import { createHash } from 'crypto';

export interface ScanFingerprintInput {
    repositoryId: string;
    vulnerabilityClass: string;
    filePath: string;
    /** The function or method holding the vulnerable operation. */
    symbol?: string;
}

/**
 * The identity a security-scan finding keeps across scans. Line numbers are
 * left out on purpose: an edit above the finding moves every line, and the
 * same finding would come back as a new issue while the old one is resolved.
 * Renaming the file or the function does change the identity — the old issue
 * is resolved and a new one opened, which is the honest outcome.
 */
export function computeScanFingerprint(input: ScanFingerprintInput): string {
    const parts = [
        input.repositoryId,
        input.vulnerabilityClass.trim().toLowerCase(),
        normalizePath(input.filePath),
        (input.symbol ?? '').trim(),
    ];

    return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

function normalizePath(path: string): string {
    return path.trim().replace(/\\/g, '/').replace(/^\.?\//, '');
}
