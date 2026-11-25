import { cweFamily } from '@libs/issues/domain/scan-fingerprint';

import type { ScanReportedFinding } from './security-scan.types';

/**
 * The reported findings a new one could share a root cause with, cheapest
 * signal first. The model judges these few; everything else is another bug.
 *
 * - The same function, or lines close by in the same file, whatever the
 *   weakness: a missing check and the denial of service it allows are one
 *   gap reported by two lenses.
 * - One sits on the other's attack path: the route, the handler and the
 *   query of one missing check.
 * - The same kind of weakness in the same module: the repository, the
 *   service and the use case of one feature (`contextReference.repository`,
 *   `context-reference.service`), or files side by side that share one guard.
 * - The same kind of weakness with a similar title anywhere: one unsafe
 *   setting repeated in every config file is one change to make.
 */
export function rootCauseCandidates(
    finding: ScanReportedFinding,
    pool: readonly ScanReportedFinding[],
    limit = ROOT_CAUSE_CANDIDATE_LIMIT,
): ScanReportedFinding[] {
    const scored: Array<{ f: ScanReportedFinding; rank: number }> = [];
    for (const other of pool) {
        if (other === finding) continue;
        const rank = linkRank(finding, other);
        if (rank !== null) scored.push({ f: other, rank });
    }
    return scored
        .sort((a, b) => a.rank - b.rank)
        .slice(0, limit)
        .map((s) => s.f);
}

export const ROOT_CAUSE_CANDIDATE_LIMIT = 8;

/** Lines apart that still read as one place in a file with no named function. */
const NEARBY_LINES = 15;

/** Lower is a stronger link; null is none. */
function linkRank(
    a: ScanReportedFinding,
    b: ScanReportedFinding,
): number | null {
    const sameFile = a.filePath === b.filePath;
    if (sameFile && a.symbol && b.symbol && a.symbol === b.symbol) return 0;
    if (
        sameFile &&
        (!a.symbol || !b.symbol) &&
        a.startLine <= b.endLine + NEARBY_LINES &&
        b.startLine <= a.endLine + NEARBY_LINES
    ) {
        return 1;
    }
    if (onPath(a, b) || onPath(b, a) || sameEntry(a, b)) return 2;
    const fa = cweFamily(a.cwe);
    const sameFamily = !!fa && fa === cweFamily(b.cwe);
    if (sameFile && sameFamily) return 3;
    if (sameFamily && sameModule(a.filePath, b.filePath)) return 4;
    if (sameFamily && titleSimilarity(a.title, b.title) >= 0.5) return 5;
    return null;
}

/** Layer suffixes one feature's files carry: `orders.service.ts`, `orders.repository.ts`. */
const LAYER =
    /[.-](repository|repo|service|controller|handler|use-?case|resolver|module|model|schema|router|routes?|dto|store|client|api|utils?|helpers?)$/;

/** Names too generic to say two files are one feature. */
const GENERIC = new Set([
    'index',
    'main',
    'app',
    'utils',
    'util',
    'helpers',
    'types',
    'fetch',
    'common',
    'shared',
    'constants',
    'config',
]);

/** A feature's name from its file: `context-reference.service.ts` → `contextreference`. */
function moduleOf(filePath: string): string | undefined {
    let stem = (filePath.split('/').pop() ?? '').replace(
        /\.[cm]?[jt]sx?$|\.[a-z]+$/i,
        '',
    );
    for (let i = 0; i < 3 && LAYER.test(stem); i++) {
        stem = stem.replace(LAYER, '');
    }
    const name = stem.toLowerCase().replace(/[^a-z0-9]/g, '');
    return name.length >= 5 && !GENERIC.has(name) ? name : undefined;
}

const dirOf = (filePath: string) =>
    filePath.slice(0, filePath.lastIndexOf('/') + 1);

/** One feature's files: the same name across layers, or files side by side. */
function sameModule(a: string, b: string): boolean {
    if (dirOf(a) && dirOf(a) === dirOf(b)) return true;
    const ma = moduleOf(a);
    return !!ma && ma === moduleOf(b);
}

/** The same file, also when one names it by its tail (`orders/repo.ts`). */
const sameFilePath = (a: string, b: string) =>
    a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

/** `b`'s file is a step of `a`'s attack path. */
function onPath(a: ScanReportedFinding, b: ScanReportedFinding): boolean {
    return (a.attackPath ?? []).some((s) => sameFilePath(s.file, b.filePath));
}

/** Both start at the same entry point: one route, a few lines apart. */
function sameEntry(a: ScanReportedFinding, b: ScanReportedFinding): boolean {
    const ea = a.attackPath?.[0];
    const eb = b.attackPath?.[0];
    return (
        !!ea &&
        !!eb &&
        sameFilePath(ea.file, eb.file) &&
        Math.abs(ea.line - eb.line) <= NEARBY_LINES
    );
}

const STOPWORDS = new Set([
    'the',
    'and',
    'any',
    'can',
    'for',
    'from',
    'into',
    'its',
    'lets',
    'let',
    'via',
    'with',
    'without',
    'that',
    'this',
    'when',
    'are',
    'not',
    'all',
    'user',
    'users',
    'attacker',
]);

function tokens(title: string): Set<string> {
    return new Set(
        (title.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(
            (t) => !STOPWORDS.has(t),
        ),
    );
}

/** Shared words over all words of two titles (Jaccard). */
export function titleSimilarity(a: string, b: string): number {
    const ta = tokens(a);
    const tb = tokens(b);
    if (!ta.size || !tb.size) return 0;
    let shared = 0;
    for (const t of ta) if (tb.has(t)) shared++;
    return shared / (ta.size + tb.size - shared);
}
