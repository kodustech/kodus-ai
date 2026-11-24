import { normalizeScanPath } from '@libs/issues/domain/scan-fingerprint';

import type { VulnClass } from './surface/surface.types';

/**
 * What a scan concluded about one file for one class of vulnerability, tied
 * to the content it read: the file's git blob and the blobs of the files the
 * conclusion leaned on (the files the lens read and the ones the map tied to
 * it). While none of those blobs changes, the conclusion holds and an
 * incremental scan does not pay to read the file again; a change to any of
 * them, a shared authorization helper included, sends it back to be read.
 */
export interface CoverageEntry {
    filePath: string;
    vulnerabilityClass: VulnClass;
    blob: string;
    evidence: Array<{ file: string; blob: string }>;
    scanId?: string;
    commitSha?: string;
    modelName?: string;
    examinedAt?: string;
}

/** How an incremental scan treats what earlier scans already read. */
export type SecurityScanMode = 'incremental' | 'full';

/** The most evidence files one conclusion records. */
export const MAX_EVIDENCE_FILES = 40;

/**
 * The files whose every recorded conclusion still holds at these blobs: the
 * file itself and every file its conclusions leaned on are unchanged. A file
 * with no conclusion on record is not among them.
 */
export function unchangedFiles(
    entries: readonly CoverageEntry[],
    blobs: ReadonlyMap<string, string>,
): Set<string> {
    const holds = new Map<string, boolean>();
    for (const entry of entries) {
        const file = normalizeScanPath(entry.filePath);
        const still =
            blobs.get(file) === entry.blob &&
            entry.evidence.every(
                (e) => blobs.get(normalizeScanPath(e.file)) === e.blob,
            );
        holds.set(file, (holds.get(file) ?? true) && still);
    }
    return new Set([...holds].filter(([, ok]) => ok).map(([file]) => file));
}

/**
 * A conclusion about `file` for `vulnerabilityClass`: the blobs of the file
 * and of the evidence files at this commit. Null when the file's blob is
 * unknown (it could not be tied to content). Evidence files the listing does
 * not hold (outside the repository, or gone) are left out.
 */
export function coverageEntryOf(params: {
    file: string;
    vulnerabilityClass: VulnClass;
    evidence: Iterable<string>;
    blobs: ReadonlyMap<string, string>;
}): CoverageEntry | null {
    const file = normalizeScanPath(params.file);
    const blob = params.blobs.get(file);
    if (!blob) return null;
    const seen = new Set<string>([file]);
    const evidence: CoverageEntry['evidence'] = [];
    for (const raw of params.evidence) {
        const f = normalizeScanPath(raw);
        if (seen.has(f)) continue;
        seen.add(f);
        const b = params.blobs.get(f);
        if (!b) continue;
        evidence.push({ file: f, blob: b });
        if (evidence.length >= MAX_EVIDENCE_FILES) break;
    }
    return {
        filePath: file,
        vulnerabilityClass: params.vulnerabilityClass,
        blob,
        evidence,
    };
}

/** `git ls-files -s -z` output → path → blob. */
export function parseStagedListing(stdout: string): Map<string, string> {
    const blobs = new Map<string, string>();
    for (const record of stdout.split('\0')) {
        // "<mode> <object> <stage>\t<path>"
        const tab = record.indexOf('\t');
        if (tab < 0) continue;
        const [, object] = record.slice(0, tab).split(' ');
        const path = record.slice(tab + 1);
        if (object && path) blobs.set(path, object);
    }
    return blobs;
}
