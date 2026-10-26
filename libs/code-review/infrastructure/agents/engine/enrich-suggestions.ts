/**
 * Enrichment step (#1821): completes the lean finder suggestions that survived
 * every other step, so each can be posted. Runs after the severity step, so
 * only what reaches the team is enriched.
 *
 * Deterministic half first (enrich-deterministic.ts): the cited code and the
 * fence language from the file at the PR head, a numbered window around the
 * cited lines and the file's diff. Then one model call per suggestion
 * (enrich-content.ts) writes the title and, when a fix fits exactly the cited
 * lines, the improved code. A failed call never drops a suggestion: it keeps
 * its cited code and gets its title from its text later in the stage.
 */
import type { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type { LangfuseTelemetryMetadata } from '@libs/core/log/langfuse';
import type { NormalizedModel } from '@libs/llm/byok-config';

import {
    enrichOneShot,
    type ContentEnrichment,
    type EnrichmentInput,
    type FixStatus,
} from './enrich-content';
import { enrichDeterministic } from './enrich-deterministic';

/** Lines of the head file shown on each side of the cited range. */
export const ENRICH_WINDOW_LINES = 60;

/** Enrichment calls in flight per review. */
export const ENRICH_CONCURRENCY = 5;

type EnrichableFile = { filename: string; fileContent?: string; patch?: string };

export type EnrichCounts = {
    enriched: number;
    failed: number;
    skipped: number;
    byFixStatus: Partial<Record<FixStatus, number>>;
};

/** Lines from..to of `content`, each prefixed with its number. The empty
 *  line after a final newline counts, as in the window the step was measured
 *  with (evals/enrichment/build-dataset.js). */
export function numberedWindow(
    content: string,
    start: number,
    end: number,
    pad = ENRICH_WINDOW_LINES,
): string {
    const lines = content.split('\n');
    const from = Math.max(1, start - pad);
    const to = Math.min(lines.length, end + pad);
    return lines
        .slice(from - 1, to)
        .map((l, i) => `${String(from + i).padStart(5)} | ${l}`)
        .join('\n');
}

/** What the enrichment call receives for one suggestion, built as production does. */
export function buildEnrichmentInput(
    suggestion: Partial<CodeSuggestion>,
    file: EnrichableFile | undefined,
): EnrichmentInput {
    const content = file?.fileContent ?? null;
    const deterministic = enrichDeterministic(suggestion, content);
    const start = suggestion.relevantLinesStart ?? 1;
    const end = suggestion.relevantLinesEnd ?? start;
    return {
        finding: {
            label: suggestion.label,
            relevantFile: suggestion.relevantFile,
            relevantLinesStart: suggestion.relevantLinesStart,
            relevantLinesEnd: suggestion.relevantLinesEnd,
            suggestionContent: suggestion.suggestionContent,
        },
        existingCode: deterministic.existingCode,
        language: deterministic.language,
        fileWindow:
            content != null && deterministic.anchorStatus === 'ok'
                ? numberedWindow(content, start, end)
                : '',
        filePatch: file?.patch ?? '',
    };
}

/** The suggestion with what the deterministic half and the model wrote. */
export function applyEnrichment(
    suggestion: Partial<CodeSuggestion>,
    input: EnrichmentInput,
    result: ContentEnrichment | null,
): Partial<CodeSuggestion> {
    return {
        ...suggestion,
        ...(input.existingCode ? { existingCode: input.existingCode } : {}),
        ...(input.language ? { language: input.language } : {}),
        ...(result?.oneSentenceSummary
            ? { oneSentenceSummary: result.oneSentenceSummary }
            : {}),
        ...(result?.fixStatus ? { fixStatus: result.fixStatus } : {}),
        ...(result?.fixStatus === 'local' && result.improvedCode
            ? { improvedCode: result.improvedCode }
            : {}),
    };
}

export async function enrichSuggestions(
    suggestions: Partial<CodeSuggestion>[],
    changedFiles: EnrichableFile[],
    opts: {
        /** Which suggestions take the step; the rest pass unchanged. */
        shouldEnrich: (s: Partial<CodeSuggestion>) => boolean;
        byokConfig?: NormalizedModel;
        telemetryMetadata?: LangfuseTelemetryMetadata;
        concurrency?: number;
        /** The model half; enrichOneShot unless a caller wraps it. */
        enrich?: typeof enrichOneShot;
    },
): Promise<{ suggestions: Partial<CodeSuggestion>[]; counts: EnrichCounts }> {
    const files = new Map(changedFiles.map((f) => [f.filename, f]));
    const enrich = opts.enrich ?? enrichOneShot;
    const counts: EnrichCounts = {
        enriched: 0,
        failed: 0,
        skipped: 0,
        byFixStatus: {},
    };
    const out = [...suggestions];
    const queue = suggestions
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => {
            const take = opts.shouldEnrich(s);
            if (!take) counts.skipped++;
            return take;
        });

    const worker = async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
            const { s, i } = next;
            const input = buildEnrichmentInput(s, files.get(s.relevantFile));
            let result: ContentEnrichment | null = null;
            try {
                result = await enrich(input, {
                    byokConfig: opts.byokConfig,
                    telemetryMetadata: opts.telemetryMetadata,
                });
            } catch {
                result = null;
            }
            if (result) {
                counts.enriched++;
                counts.byFixStatus[result.fixStatus] =
                    (counts.byFixStatus[result.fixStatus] || 0) + 1;
            } else {
                counts.failed++;
            }
            out[i] = applyEnrichment(s, input, result);
        }
    };
    await Promise.all(
        Array.from(
            { length: Math.max(1, opts.concurrency ?? ENRICH_CONCURRENCY) },
            worker,
        ),
    );
    return { suggestions: out, counts };
}
