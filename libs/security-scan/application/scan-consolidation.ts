/**
 * One issue per root cause. A finding the scan reports is compared with the
 * few reported ones it could share a cause with (rootCauseCandidates) and the
 * model says whether one fix closes both; when it does, the finding becomes
 * one more place of that issue instead of an issue of its own. The same check
 * runs over a repository's open issues, so the duplicates earlier scans
 * opened fold into one.
 */
import { z } from 'zod';

import { createLogger } from '@libs/core/log/logger';
import type { LLM } from '@libs/llm/llm';
import type { NormalizedModel } from '@libs/llm/byok-config';

import { rootCauseCandidates } from '../domain/root-cause';
import {
    buildRootCauseUserPrompt,
    ROOT_CAUSE_SYSTEM_PROMPT,
} from '../domain/scan-prompts';
import type {
    ScanFinding,
    ScanReportedFinding,
} from '../domain/security-scan.types';

const logger = createLogger('SecurityScanConsolidation');

export const ROOT_CAUSE_RUN_NAME = 'security-scan-root-cause';

export const ROOT_CAUSE_SCHEMA = z.object({
    sameAs: z.string(),
    reason: z.string(),
});

/** One structured model request: the scan's metered model call. */
export type RootCauseCall = (request: {
    system: string;
    user: string;
    schema: typeof ROOT_CAUSE_SCHEMA;
    runName: string;
}) => Promise<z.infer<typeof ROOT_CAUSE_SCHEMA> | undefined>;

/**
 * The comparison as the end of a scan asks it: one structured request on the
 * scan's own model (no failover, as every scan request). Shared with the eval.
 */
export function rootCauseCallOn(
    llm: typeof LLM.run,
    slot: NormalizedModel,
    organizationId: string,
): RootCauseCall {
    return (request) =>
        llm({
            byokConfig: slot,
            schema: request.schema,
            system: request.system,
            user: request.user,
            runName: request.runName,
            organizationId,
        }) as Promise<z.infer<typeof ROOT_CAUSE_SCHEMA>>;
}

/**
 * The reported finding `finding` is the same problem as, or null. Asks the
 * model only when a candidate exists; an answer naming no candidate, or a
 * failed call, is "none": two issues for one bug cost less than a lost one.
 */
export async function sameRootCause<T extends ScanReportedFinding>(
    call: RootCauseCall,
    finding: ScanReportedFinding,
    pool: readonly T[],
): Promise<{ match: T; reason: string } | null> {
    const candidates = rootCauseCandidates(finding, pool) as T[];
    if (!candidates.length) return null;
    const answer = await call({
        system: ROOT_CAUSE_SYSTEM_PROMPT,
        user: buildRootCauseUserPrompt({
            finding,
            candidates: candidates.map((c, i) => ({ ...c, id: `c${i + 1}` })),
        }),
        schema: ROOT_CAUSE_SCHEMA,
        runName: ROOT_CAUSE_RUN_NAME,
    });
    const id = String(answer?.sameAs ?? '')
        .trim()
        .toLowerCase()
        .replace(/^id\s*/, '');
    const index = /^c?(\d+)$/.exec(id)?.[1];
    const match = index ? candidates[Number(index) - 1] : undefined;
    return match ? { match, reason: answer?.reason ?? '' } : null;
}

export interface OpenScanIssue extends ScanReportedFinding {
    fingerprint: string;
}

export interface ConsolidationResult<T extends OpenScanIssue> {
    /** Issues folded into another: `into` is the one that stays. */
    absorbed: Array<{ issue: T; into: T; reason: string }>;
    /** The subjects compared to the end: the rest wait for a later scan. */
    compared: string[];
    /** Model calls that failed; their issues were left as they are. */
    failures: number;
}

const SEVERITY_RANK: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
};

/**
 * Folds a repository's open issues that share a root cause. `subjects` are
 * the issues not compared since they last changed; each is compared with
 * every open issue still standing, most severe first, so the issue that
 * stays is the more severe one when two are one bug. Stops at the first
 * failure the caller marks as final (the spend cap): what is left is compared
 * on a later scan.
 */
export async function consolidateOpenIssues<T extends OpenScanIssue>(
    call: RootCauseCall,
    open: readonly T[],
    subjects: ReadonlySet<string>,
    opts: {
        /** A failure that ends the sweep (the spend cap). */
        isFinal?: (error: unknown) => boolean;
        /** Checked before each comparison: true ends the sweep there. */
        shouldStop?: () => boolean;
    } = {},
): Promise<ConsolidationResult<T>> {
    const ordered = [...open].sort(
        (a, b) =>
            (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4),
    );
    const absorbedSet = new Set<string>();
    const absorbed: ConsolidationResult<T>['absorbed'] = [];
    const compared: string[] = [];
    let failures = 0;
    for (const issue of ordered) {
        if (!subjects.has(issue.fingerprint)) continue;
        if (absorbedSet.has(issue.fingerprint)) {
            compared.push(issue.fingerprint);
            continue;
        }
        if (opts.shouldStop?.()) break;
        const standing = ordered.filter(
            (o) =>
                o.fingerprint !== issue.fingerprint &&
                !absorbedSet.has(o.fingerprint),
        );
        try {
            const same = await sameRootCause(call, issue, standing);
            compared.push(issue.fingerprint);
            if (!same) continue;
            // The one that stays is the more severe, then the earlier.
            const [keep, fold] =
                ordered.indexOf(same.match) <= ordered.indexOf(issue)
                    ? [same.match, issue]
                    : [issue, same.match];
            absorbedSet.add(fold.fingerprint);
            absorbed.push({ issue: fold, into: keep, reason: same.reason });
        } catch (error) {
            if (opts.isFinal?.(error)) break;
            failures++;
            logger.warn({
                message:
                    'Security scan could not compare an issue for a shared root cause',
                context: 'SecurityScanConsolidation',
                error,
            });
        }
    }
    // An issue folded into one that was later folded itself points at the
    // one that stays.
    const finalOf = (f: T): T => {
        let at = f;
        for (let i = 0; i < absorbed.length; i++) {
            const next = absorbed.find((a) => a.issue === at)?.into;
            if (!next) break;
            at = next;
        }
        return at;
    };
    return {
        absorbed: absorbed.map((a) => ({ ...a, into: finalOf(a.into) })),
        compared,
        failures,
    };
}

/** The occurrence of a finding folded into another issue, as the issue keeps it. */
export function occurrenceOf(
    finding: Pick<
        ScanFinding,
        | 'title'
        | 'cwe'
        | 'filePath'
        | 'startLine'
        | 'endLine'
        | 'symbol'
        | 'severity'
        | 'vulnerabilityClass'
    >,
    fingerprint: string,
) {
    return {
        fingerprint,
        title: finding.title,
        cwe: finding.cwe,
        filePath: finding.filePath,
        startLine: finding.startLine,
        endLine: finding.endLine,
        symbol: finding.symbol,
        severity: finding.severity,
        vulnerabilityClass: finding.vulnerabilityClass,
    };
}
