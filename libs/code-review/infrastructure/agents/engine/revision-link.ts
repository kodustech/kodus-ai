import type { PrDecisionRecord } from '@libs/code-review/domain/contracts/pr-decision-store.contract';

/**
 * #2039/#2020: a finding that revises, reverses or exists because of an
 * earlier Kody suggestion on this PR says so. The finder names the earlier
 * suggestion by id (`revisesSuggestionId`); this renders which one, in a line
 * the formatter never sees. An id that matches no earlier suggestion is
 * dropped, not rendered.
 */
export interface RevisableSuggestion {
    revisesSuggestionId?: string;
    suggestionContent?: string;
    fullExplanation?: string;
    llmPrompt?: string;
}

export function revisionLinkLine(prior: PrDecisionRecord): string {
    const where = prior.relevantFile
        ? `\`${prior.relevantFile}${prior.relevantLinesStart != null ? `:${prior.relevantLinesStart}` : ''}\``
        : 'this pull request';
    const when = prior.decidedAt
        ? ` (${prior.decidedAt.slice(0, 16).replace('T', ' ')} UTC)`
        : '';
    return `**Revises an earlier Kody suggestion** on ${where}${when}.`;
}

/** Prefixes the link line in place; returns how many were linked. */
export function applyRevisionLinks(
    suggestions: RevisableSuggestion[],
    previousDecisions: readonly PrDecisionRecord[] | undefined,
): number {
    let linked = 0;
    const priorById = new Map<string, PrDecisionRecord | undefined>();
    for (const decision of previousDecisions ?? []) {
        // Never guess which comment a duplicate reference identifies.
        priorById.set(
            decision.suggestionId,
            priorById.has(decision.suggestionId) ? undefined : decision,
        );
    }
    for (const s of suggestions) {
        const prior = s.revisesSuggestionId
            ? priorById.get(s.revisesSuggestionId)
            : undefined;
        if (!prior) {
            if (s.revisesSuggestionId) delete s.revisesSuggestionId;
            continue;
        }
        const line = revisionLinkLine(prior);
        if (!(s.suggestionContent || '').startsWith(line)) {
            s.suggestionContent = `${line}\n\n${s.suggestionContent || ''}`;
        }
        if (s.fullExplanation && !s.fullExplanation.startsWith(line)) {
            s.fullExplanation = `${line}\n\n${s.fullExplanation}`;
        }
        if (s.llmPrompt && !s.llmPrompt.startsWith(line)) {
            s.llmPrompt = `${line}\n\n${s.llmPrompt}`;
        }
        linked++;
    }
    return linked;
}
