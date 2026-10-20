import type { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { shapeSuggestionBodyWithReport } from '@libs/common/utils/codeManagement/suggestion-body-shape';
import {
    boundSuggestionTitle,
    MAX_TITLE_CHARS,
} from '@libs/common/utils/codeManagement/suggestion-title';
import { isAnalyzerSuggestion } from '@libs/code-review/infrastructure/analyzers/analyzer-findings-to-suggestions';
import {
    impactAndActionFallback,
    stripReviewScaffolding,
} from '@libs/code-review/infrastructure/agents/engine/strip-review-scaffolding';
import {
    customAgentWriting,
    type CustomAgentsById,
} from '@libs/code-review/infrastructure/agents/custom-agents/custom-agent-presentation';

export interface SuggestionShapeCounts {
    shaped: number;
    removedFences: number;
    droppedTitleRepeat: number;
    capped: number;
    impactActionFallback: number;
    /** Titles over the ceiling the formatter rewrote. */
    titleRewritten: number;
    /** Titles still over the ceiling, cut at a word boundary. */
    titleCut: number;
}

export interface FormatAndShapeResult {
    /** Entries the formatter returned; null when the call threw. */
    formatted: number | null;
    /** Findings handed to the formatter (every finding but the analyzers'). */
    formatTargets: number;
    /** What the formatter threw; the findings then keep their own text. */
    formatError?: unknown;
    shapeCounts: SuggestionShapeCounts;
}

/**
 * The text each finding ships with: the formatter's rewrite (WHAT/WHY/HOW
 * labels merged into prose), then the shape the comment needs whether or not
 * the model complied. Rewrites `suggestionContent` in place, and bounds
 * `oneSentenceSummary`: a title over MAX_TITLE_CHARS is rewritten by the
 * formatter, and cut only when it is still too long after it. AgentReviewStage
 * runs it on its findings; evals/format runs it on recorded findings, so both
 * run this code.
 */
export async function formatAndShapeSuggestions(
    suggestions: Partial<CodeSuggestion>[],
    options: {
        /** resolveWritingGuidelines' result for the team's generation.main. */
        writingGuidelines: { text: string; isCustom: boolean };
        byokConfig?: NormalizedModel;
        languageResultPrompt?: string;
        /** The org the formatter call is billed and traced to; every caller
         *  passes it, even when the review has none. */
        organizationId: string | undefined;
        /** The review's custom agents (#2172): an agent's writing
         *  instructions replace the team's for its own findings. Without it
         *  every finding is written in the team's voice. */
        customAgentsById?: CustomAgentsById;
    },
): Promise<FormatAndShapeResult> {
    const { writingGuidelines } = options;
    const formattedTargets = new Set<Partial<CodeSuggestion>>();
    const rewrittenTitles = new Set<Partial<CodeSuggestion>>();
    const isOverCeiling = (s: Partial<CodeSuggestion>): boolean =>
        (s.oneSentenceSummary || '').length > MAX_TITLE_CHARS;
    // Only a title that was offered for rewriting: a model that retitles a
    // finding unasked does not change it. The prompt's example quotes its
    // title, so a quoted answer loses the quotes.
    const acceptTitle = (
        s: Partial<CodeSuggestion>,
        raw: string | undefined,
    ): void => {
        const title = (raw ?? '')
            .trim()
            .replace(/^["\u201c](.+)["\u201d]$/s, '$1');
        if (!boundSuggestionTitle(title) || !isOverCeiling(s)) return;
        s.oneSentenceSummary = title;
        rewrittenTitles.add(s);
    };
    // Deterministic findings skip the pass. Their body is already the
    // structured list the builder produced, and a polish pass reflowed it into
    // one paragraph — losing the per-package lines and appending remediation
    // advice the scanner never said. There is no WHAT/WHY/HOW scaffolding here
    // to strip.
    const formatTargets = suggestions
        .map((s, i) => (isAnalyzerSuggestion(s) ? -1 : i))
        .filter((i) => i >= 0);
    let formattedCount: number | null = null;
    let formatError: unknown;
    try {
        const {
            formatSuggestionContent,
        } = require('@libs/code-review/infrastructure/agents/engine/format-suggestion-content');
        // A custom agent's writing instructions replace the team's for its
        // own findings (#2172): one formatter call per voice.
        const targetsByWriting = new Map<string | undefined, number[]>();
        for (const i of formatTargets) {
            const writing = options.customAgentsById
                ? customAgentWriting(suggestions[i], options.customAgentsById)
                : undefined;
            if (!targetsByWriting.has(writing)) {
                targetsByWriting.set(writing, []);
            }
            targetsByWriting.get(writing)!.push(i);
        }
        let count = 0;
        for (const [agentWriting, voiceTargets] of targetsByWriting) {
            const formatted = await formatSuggestionContent(
                voiceTargets.map((i) => ({
                    title: suggestions[i].oneSentenceSummary || '',
                    rewriteTitle: isOverCeiling(suggestions[i]),
                    suggestionContent: suggestions[i].suggestionContent || '',
                    existingCode: suggestions[i].existingCode || '',
                    improvedCode: suggestions[i].improvedCode || '',
                    relevantFile: suggestions[i].relevantFile || '',
                    language: suggestions[i].language || '',
                })),
                {
                    // A saved copy of a shipped default is not the team's own
                    // text; only a real edit outranks the formatter's rules.
                    customWritingGuidelines:
                        agentWriting ??
                        (writingGuidelines.isCustom
                            ? writingGuidelines.text
                            : undefined),
                    byokConfig: options.byokConfig,
                    // The team's language, set in General, holds for an
                    // agent's voice too.
                    languageResultPrompt: options.languageResultPrompt,
                    organizationId: options.organizationId,
                },
            );
            for (const [i, fmt] of formatted) {
                const target = voiceTargets[i];
                if (
                    target !== undefined &&
                    suggestions[target] &&
                    fmt.suggestionContent?.trim()
                ) {
                    formattedTargets.add(suggestions[target]);
                    suggestions[target].suggestionContent =
                        fmt.suggestionContent;
                    acceptTitle(suggestions[target], fmt.title);
                }
            }
            count += formatted.size;
        }
        formattedCount = count;
    } catch (err) {
        formatError = err;
    }

    // The shape the comment needs does not depend on the model complying: no
    // code blocks, no opening sentence that restates the title, and two
    // sentences unless the team set its own length. Deterministic findings
    // keep their structured list.
    const shapeCounts: SuggestionShapeCounts = {
        shaped: 0,
        removedFences: 0,
        droppedTitleRepeat: 0,
        capped: 0,
        impactActionFallback: 0,
        titleRewritten: rewrittenTitles.size,
        titleCut: 0,
    };
    // Every finding renders under a bounded title, the analyzers' included;
    // bounded before shaping so the body is compared with the title shown.
    for (const s of suggestions) {
        if (s.oneSentenceSummary == null) continue;
        const bounded = boundSuggestionTitle(s.oneSentenceSummary);
        if (bounded.endsWith('…') && bounded !== s.oneSentenceSummary) {
            shapeCounts.titleCut++;
        }
        s.oneSentenceSummary = bounded;
    }
    for (const s of suggestions) {
        if (isAnalyzerSuggestion(s)) continue;
        const fallback =
            !writingGuidelines.isCustom && !formattedTargets.has(s)
                ? impactAndActionFallback(s.suggestionContent || '')
                : undefined;
        if (fallback) shapeCounts.impactActionFallback++;
        const shaped = shapeSuggestionBodyWithReport({
            body: stripReviewScaffolding(fallback || s.suggestionContent || ''),
            title: s.oneSentenceSummary,
            capSentences: !writingGuidelines.isCustom,
        });
        s.suggestionContent = shaped.body;
        shapeCounts.shaped++;
        if (shaped.removedFences) shapeCounts.removedFences++;
        if (shaped.droppedTitleRepeat) shapeCounts.droppedTitleRepeat++;
        if (shaped.capped) shapeCounts.capped++;
    }

    return {
        formatted: formattedCount,
        formatTargets: formatTargets.length,
        ...(formatError !== undefined ? { formatError } : {}),
        shapeCounts,
    };
}
