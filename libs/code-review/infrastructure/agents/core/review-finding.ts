/**
 * code-review (domain) — `ReviewFinding` entity + recall-funnel observability.
 *
 * WHY: a true bug from the PR dies at one of four gates — never found (G0
 * coverage), merged (G1 dedup), dropped (G2 verify), or cut (G3 severity). Today
 * those losses live in parallel lists (`kept`, `droppedByVerify`,
 * `discardedBySeverity`, dedup output) so "recall = 30%" is a number at the end
 * and none of the gates. A finding with an explicit LIFECYCLE turns each loss
 * into an attributable event — the dataset the ratchet needs to ask "where did
 * recall die, and for which severity/category?".
 *
 * Design: this does NOT replace `FinderSuggestion` (the LLM I/O contract) — it
 * WRAPS it. The suggestion is what the model emits; the `ReviewFinding` is what
 * the funnel carries. Principle: a finding is never deleted — it is MARKED with
 * a `GateEvent`. Delivery filters `outcome:'posted'`; recall measurement reads
 * the full history. The difference between "it vanished" and "it died at gate X
 * with reason Y".
 *
 * Boundary: review-domain, not the harness. The harness stays generic
 * (RunState/Artifact); this maps that to the review-specific funnel.
 *
 * Slice 1 covers the VERIFY gate (the documented recall bottleneck — verify
 * drops ~85% of findings). Dedup (G1) and severity (G3) gates layer on later
 * at the orchestrator/stage level, reusing the same `GateEvent` shape.
 */
import type { FinderSuggestion, FinderWithVerifyResult } from './finder.agent';
import type { ToolEvidenceSummary } from '@libs/code-review/infrastructure/agents/review-agent.contract';

export type Gate = 'found' | 'dedup' | 'verify' | 'severity' | 'post';
export type GateOutcome =
    | 'survived'
    | 'merged'
    | 'dropped'
    | 'cut'
    | 'posted';

export interface GateEvent {
    readonly gate: Gate;
    readonly outcome: GateOutcome;
    /** Human-readable reason (the verify rationale, the dedup merge target…). */
    readonly reason?: string;
    /** When merged: the id of the finding that absorbed this one. */
    readonly mergedInto?: string;
}

export interface FindingProvenance {
    /** Which finder produced it (bug/security/performance/generalist/kody-rules…). */
    readonly agent: string;
    /** Which pass of the pipeline it was born in. */
    readonly pass: 'initial' | 'coverage-recovery' | 'second-chance' | 'synthesis';
    readonly model?: string;
    /** Self-reported confidence (1-10) — NOT trustworthy, telemetry only. */
    readonly selfConfidence?: number;
}

export interface ReviewFinding {
    readonly id: string;
    /** The payload that reaches the user — mirrors `FinderSuggestion`. */
    readonly payload: FinderSuggestion;
    readonly provenance: FindingProvenance;
    /** Tool evidence gathered while finding/judging it (provenance of trust). */
    readonly evidence?: ToolEvidenceSummary;
    /** The ordered lifecycle. Unifies kept / droppedByVerify / dedup / severity. */
    readonly gates: readonly GateEvent[];
}

/** Stable id — generated at creation, never reuses an array index (so merges /
 *  reorders can't break the reference, and provenance has an anchor). */
export function makeFindingId(
    payload: FinderSuggestion,
    agent: string,
): string {
    const key = `${payload.relevantFile}:${payload.relevantLinesStart ?? '?'}:${payload.suggestionContent}`;
    return `${agent}:${payload.relevantFile}:${payload.relevantLinesStart ?? 0}:${shortHash(key)}`;
}

/** Small, dependency-free stable string hash (djb2). Telemetry id only — not
 *  security-sensitive, so no crypto import. */
function shortHash(input: string): string {
    let h = 5381;
    for (let i = 0; i < input.length; i++) {
        h = (h * 33) ^ input.charCodeAt(i);
    }
    // >>> 0 → unsigned; base36 for compactness.
    return (h >>> 0).toString(36);
}

/** The gate where a finding's lifecycle ended badly, if any (the FIRST
 *  non-surviving outcome). `undefined` → still alive / delivered. */
export function diedAt(finding: ReviewFinding): Gate | undefined {
    const death = finding.gates.find(
        (g) => g.outcome === 'merged' || g.outcome === 'dropped' || g.outcome === 'cut',
    );
    return death?.gate;
}

/**
 * Build the lifecycle-carrying findings from a finished finder+verify run.
 * `kept` survived the verify gate; `droppedByVerify` died at it (with the
 * verifier's reason). Both passed the implicit `found` gate. Pure — no I/O.
 */
export function buildFindingsFromVerify(
    result: FinderWithVerifyResult,
    provenance: Omit<FindingProvenance, 'selfConfidence'>,
): ReviewFinding[] {
    const prov = (payload: FinderSuggestion): FindingProvenance => ({
        ...provenance,
        selfConfidence: payload.confidence,
    });

    const kept: ReviewFinding[] = result.kept.map((payload, i) => ({
        id: makeFindingId(payload, provenance.agent),
        payload,
        provenance: prov(payload),
        evidence: result.keptEvidence[i],
        gates: [
            { gate: 'found', outcome: 'survived' },
            { gate: 'verify', outcome: 'survived' },
        ],
    }));

    const dropped: ReviewFinding[] = result.droppedByVerify.map((d) => ({
        id: makeFindingId(d.finding, provenance.agent),
        payload: d.finding,
        provenance: prov(d.finding),
        evidence: d.verifierEvidence,
        gates: [
            { gate: 'found', outcome: 'survived' },
            { gate: 'verify', outcome: 'dropped', reason: d.evidence },
        ],
    }));

    return [...kept, ...dropped];
}

export interface FunnelSlice {
    readonly found: number;
    readonly dropped: number;
}

/**
 * The recall funnel as counts — the dataset the ratchet/benchmark joins against
 * ground-truth. `bySeverity`/`byLabel` expose WHERE recall dies, not just that
 * it did. Slice 1 reports the verify gate; later gates extend `byGate`.
 */
export interface FunnelReport {
    readonly found: number;
    readonly survivedVerify: number;
    readonly droppedByVerify: number;
    readonly bySeverity: Readonly<Record<string, FunnelSlice>>;
    readonly byLabel: Readonly<Record<string, FunnelSlice>>;
}

export function summarizeFunnel(
    findings: readonly ReviewFinding[],
): FunnelReport {
    const bySeverity: Record<string, { found: number; dropped: number }> = {};
    const byLabel: Record<string, { found: number; dropped: number }> = {};
    let droppedByVerify = 0;

    for (const f of findings) {
        const died = diedAt(f) === 'verify';
        if (died) droppedByVerify++;

        const sev = f.payload.severity ?? 'unknown';
        const lab = f.payload.label ?? 'unknown';
        (bySeverity[sev] ??= { found: 0, dropped: 0 }).found++;
        (byLabel[lab] ??= { found: 0, dropped: 0 }).found++;
        if (died) {
            bySeverity[sev].dropped++;
            byLabel[lab].dropped++;
        }
    }

    return {
        found: findings.length,
        survivedVerify: findings.length - droppedByVerify,
        droppedByVerify,
        bySeverity,
        byLabel,
    };
}
