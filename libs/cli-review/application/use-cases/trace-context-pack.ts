/**
 * Pure helpers for injecting Kodus Trace decisions into the review prompt.
 * Path-scoped, token-budgeted, pin-protected. No embeddings.
 */

export interface TraceDecision {
    id: string;
    type: string;
    decision: string;
    rationale?: string;
    confidence?: number;
    evidence?: string[];
    paths?: string[];
    pinned?: boolean;
    forgotten?: boolean;
}

export const TRACE_CONTEXT_PACK_TOKEN_BUDGET = 2000;

function normalizePath(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

export function pathMatchesDecision(
    decisionPath: string,
    changedPaths: string[],
): boolean {
    const dp = normalizePath(decisionPath);
    if (!dp) {
        return false;
    }
    for (const q of changedPaths) {
        const qp = normalizePath(q);
        if (!qp) {
            continue;
        }
        if (dp === qp) {
            return true;
        }
        if (qp.startsWith(dp + '/') || dp.startsWith(qp + '/')) {
            return true;
        }
    }
    return false;
}

export function filterDecisionsForChangedFiles(
    decisions: TraceDecision[],
    changedPaths: string[],
): TraceDecision[] {
    return decisions.filter((d) => {
        if (d.forgotten) {
            return false;
        }
        const scopes = [
            ...(d.paths ?? []),
            ...(d.evidence ?? []).filter(
                (e) => e.includes('/') || /\.\w+$/.test(e),
            ),
        ];
        if (scopes.length === 0) {
            return false;
        }
        return scopes.some((s) => pathMatchesDecision(s, changedPaths));
    });
}

export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

export function formatTraceDecisions(decisions: TraceDecision[]): string {
    return decisions
        .map((d) => {
            const pin = d.pinned ? ' [pinned]' : '';
            const conf =
                typeof d.confidence === 'number'
                    ? ` conf=${d.confidence.toFixed(2)}`
                    : '';
            const why = d.rationale ? `\n  why: ${d.rationale}` : '';
            return `- [${d.id}] (${d.type}${conf})${pin} ${d.decision}${why}`;
        })
        .join('\n');
}

/**
 * Select decisions for the pack: path-scoped, drop lowest confidence first,
 * never drop pinned. Cap at budgetTokens.
 */
export function selectTraceContextPack(
    decisions: TraceDecision[],
    changedPaths: string[],
    budgetTokens = TRACE_CONTEXT_PACK_TOKEN_BUDGET,
): TraceDecision[] {
    const matched = filterDecisionsForChangedFiles(decisions, changedPaths);
    const pinned = matched.filter((d) => d.pinned);
    const unpinned = matched
        .filter((d) => !d.pinned)
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));

    const selected: TraceDecision[] = [...pinned];
    for (const d of unpinned) {
        const next = estimateTokens(formatTraceDecisions([...selected, d]));
        if (next > budgetTokens) {
            continue;
        }
        selected.push(d);
    }
    return selected;
}

/**
 * Render the block injected into the review prompt.
 * Empty string when no decisions — callers should leave the prompt byte-identical.
 */
export function renderTraceContextPack(decisions: TraceDecision[]): string {
    if (decisions.length === 0) {
        return '';
    }
    return [
        '## Kodus Trace — decisions for changed files',
        '',
        'The following decisions were recorded while this code was written.',
        'Treat deliberate tradeoffs as intentional unless the diff clearly regresses them.',
        '',
        formatTraceDecisions(decisions),
    ].join('\n');
}

/**
 * Inject pack into an existing prompt. When pack is empty, returns `prompt` unchanged
 * (same reference if empty string) for byte-identical inert behaviour.
 */
export function injectTraceContextPack(prompt: string, pack: string): string {
    if (!pack) {
        return prompt;
    }
    return `${prompt}\n\n${pack}`;
}
