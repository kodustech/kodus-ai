import { createHash } from 'node:crypto';

export type BugFixEvidence = 'linked-bug-issue' | 'title-signal';

export interface HistoricalAreaPullRequest {
    number: number;
    url: string;
    title: string;
    mergedAt: string;
    /** A null value means the provider could not report linked issues. */
    linkedBugIssues: string[] | null;
    files: string[];
    /** False when the provider truncated or failed the file listing. */
    filesComplete: boolean;
}

export interface AreaEvidence {
    prNumber: number;
    prUrl: string;
    mergedAt: string;
    bugFixEvidence?: BugFixEvidence;
    bugIssueUrls?: string[];
}

export interface CodeAreaRecord {
    path: string;
    changedPrs: number;
    linkedBugFixPrs: number;
    titleBugFixPrs: number;
    recentEvidence: AreaEvidence[];
    linkedBugEvidence?: AreaEvidence[];
    /** Optional JS/TS structural sample from the repository default branch. */
    structure?: {
        eligibleFiles: number;
        analyzedFiles: number;
        functions: number;
        functionsNeedingAttention: number;
        files: Array<{
            path: string;
            functions: number;
            functionsNeedingAttention: number;
        }>;
    };
}

export interface CodeAreaRiskMap {
    version: string;
    source: string;
    windowStart: string;
    windowEnd: string;
    refreshedAt: string;
    coverage: {
        discoveredMergedPrs: number;
        scannedPrs: number;
        prsWithCompleteFiles: number;
        prsWithIssueSupport: number;
        scanComplete: boolean;
        sampled?: boolean;
    };
    files: CodeAreaRecord[];
    directories: CodeAreaRecord[];
    directDirectories: CodeAreaRecord[];
    structureCoverage?: {
        eligibleFiles: number;
        analyzedFiles: number;
        sampled: boolean;
    };
}

/** Heuristic evidence order, not a bug probability. Churn is the eval control. */
export function rankCodeAreas(
    records: CodeAreaRecord[],
    basis: 'bug-evidence' | 'churn' = 'bug-evidence',
): CodeAreaRecord[] {
    const score = (area: CodeAreaRecord) =>
        basis === 'churn'
            ? area.changedPrs
            : area.changedPrs +
              (0.25 * (3 * area.linkedBugFixPrs + area.titleBugFixPrs)) /
                  Math.sqrt(Math.max(area.changedPrs, 1));
    return [...records].sort(
        (a, b) =>
            score(b) - score(a) ||
            b.changedPrs - a.changedPrs ||
            a.path.localeCompare(b.path),
    );
}

const MAX_EVIDENCE_PER_AREA = 5;
const BUG_FIX_TITLE = /\b(?:fix(?:es|ed)?|bug(?:fix)?|regression|hotfix)\b/i;

function normalizedPath(path: string): string | null {
    const segments = path.replaceAll('\\', '/').split('/');
    if (
        !segments.length ||
        segments.some((segment) => ['', '.', '..'].includes(segment))
    ) {
        return null;
    }
    return segments.join('/');
}

function directoryPaths(filePath: string): string[] {
    const segments = filePath.split('/');
    return segments
        .slice(1)
        .map((_, index) => segments.slice(0, index + 1).join('/'));
}

function addEvidence(
    records: Map<string, CodeAreaRecord>,
    path: string,
    evidence: AreaEvidence,
): void {
    let record = records.get(path);
    if (!record) {
        record = {
            path,
            changedPrs: 0,
            linkedBugFixPrs: 0,
            titleBugFixPrs: 0,
            recentEvidence: [],
            linkedBugEvidence: [],
        };
        records.set(path, record);
    }
    record.changedPrs += 1;
    if (evidence.bugFixEvidence === 'linked-bug-issue') {
        record.linkedBugFixPrs += 1;
    } else if (evidence.bugFixEvidence === 'title-signal') {
        record.titleBugFixPrs += 1;
    }
    if (record.recentEvidence.length < MAX_EVIDENCE_PER_AREA) {
        record.recentEvidence.push(evidence);
    }
    if (
        evidence.bugFixEvidence === 'linked-bug-issue' &&
        (record.linkedBugEvidence?.length ?? 0) < MAX_EVIDENCE_PER_AREA
    ) {
        record.linkedBugEvidence?.push(evidence);
    }
}

/** Build a historical evidence map. Policy marks belong to team config, never here. */
export function buildCodeAreaRiskMap(params: {
    source: string;
    windowStart: string;
    windowEnd: string;
    refreshedAt: string;
    discoveredMergedPrs: number;
    scanComplete?: boolean;
    sampled?: boolean;
    pullRequests: HistoricalAreaPullRequest[];
}): CodeAreaRiskMap {
    const start = Date.parse(params.windowStart);
    const end = Date.parse(params.windowEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
        throw new Error('Invalid code-area history window');
    }
    const files = new Map<string, CodeAreaRecord>();
    const directories = new Map<string, CodeAreaRecord>();
    const directDirectories = new Map<string, CodeAreaRecord>();
    const inWindow = params.pullRequests
        .filter((pr) => {
            const mergedAt = Date.parse(pr.mergedAt);
            return mergedAt >= start && mergedAt < end;
        })
        .sort(
            (a, b) =>
                b.mergedAt.localeCompare(a.mergedAt) || a.number - b.number,
        );

    for (const pr of inWindow) {
        const bugIssueUrls = [...new Set(pr.linkedBugIssues ?? [])].sort();
        const bugFixEvidence: BugFixEvidence | undefined =
            bugIssueUrls.length > 0
                ? 'linked-bug-issue'
                : BUG_FIX_TITLE.test(pr.title)
                  ? 'title-signal'
                  : undefined;
        const evidence: AreaEvidence = {
            prNumber: pr.number,
            prUrl: pr.url,
            mergedAt: pr.mergedAt,
            ...(bugFixEvidence ? { bugFixEvidence } : {}),
            ...(bugIssueUrls.length ? { bugIssueUrls } : {}),
        };
        const uniqueFiles = new Set(
            pr.files
                .map(normalizedPath)
                .filter((path): path is string => !!path),
        );
        const uniqueDirectories = new Set<string>();
        const uniqueDirectDirectories = new Set<string>();
        for (const path of uniqueFiles) {
            addEvidence(files, path, evidence);
            const parent = path.includes('/')
                ? path.slice(0, path.lastIndexOf('/'))
                : '.';
            uniqueDirectDirectories.add(parent);
            for (const directory of directoryPaths(path)) {
                uniqueDirectories.add(directory);
            }
        }
        for (const path of uniqueDirectories) {
            addEvidence(directories, path, evidence);
        }
        for (const path of uniqueDirectDirectories) {
            addEvidence(directDirectories, path, evidence);
        }
    }

    const byPath = (a: CodeAreaRecord, b: CodeAreaRecord) =>
        a.path.localeCompare(b.path);
    const result: CodeAreaRiskMap = {
        version: '',
        source: params.source,
        windowStart: params.windowStart,
        windowEnd: params.windowEnd,
        refreshedAt: params.refreshedAt,
        coverage: {
            discoveredMergedPrs: params.discoveredMergedPrs,
            scannedPrs: inWindow.length,
            prsWithCompleteFiles: inWindow.filter((pr) => pr.filesComplete)
                .length,
            prsWithIssueSupport: inWindow.filter(
                (pr) => pr.linkedBugIssues !== null,
            ).length,
            scanComplete: params.scanComplete ?? false,
            ...(params.sampled ? { sampled: true } : {}),
        },
        files: [...files.values()].sort(byPath),
        directories: [...directories.values()].sort(byPath),
        directDirectories: [...directDirectories.values()].sort(byPath),
    };
    result.version = createHash('sha256')
        .update(
            JSON.stringify({
                source: result.source,
                windowStart: result.windowStart,
                windowEnd: result.windowEnd,
                coverage: result.coverage,
                files: result.files,
                directories: result.directories,
                directDirectories: result.directDirectories,
            }),
        )
        .digest('hex');
    return result;
}
