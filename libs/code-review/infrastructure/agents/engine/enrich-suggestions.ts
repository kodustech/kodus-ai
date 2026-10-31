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
import { convertToUnifiedDiffWithLineNumbers } from '@libs/common/utils/patch';
import { createLogger } from '@libs/core/log/logger';

const logger = createLogger('EnrichSuggestions');

/** Lines of the head file shown on each side of the cited range. */
export const ENRICH_WINDOW_LINES = 60;

/** Enrichment calls in flight per review. */
export const ENRICH_CONCURRENCY = 5;

type EnrichableFile = {
    filename: string;
    fileContent?: string;
    patch?: string;
    patchWithLinesStr?: string;
};

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

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The new-side lines of a unified diff (added and context), by line number
 *  in the file at the head. */
export function newSideLines(patch: string): Map<number, string> {
    const out = new Map<number, string>();
    let line = 0;
    for (const raw of (patch || '').split('\n')) {
        const header = HUNK_HEADER.exec(raw);
        if (header) {
            line = Number(header[1]);
            continue;
        }
        if (!line || raw.startsWith('-') || raw.startsWith('\\')) continue;
        out.set(line, raw.startsWith('+') || raw.startsWith(' ') ? raw.slice(1) : raw);
        line++;
    }
    return out;
}

/** The cited lines, when every one of them is on the new side of the diff. */
function citedFromPatch(
    patch: string,
    start: number,
    end: number,
): string {
    const lines = newSideLines(patch);
    const cited: string[] = [];
    for (let n = start; n <= end; n++) {
        const l = lines.get(n);
        if (l === undefined) return '';
        cited.push(l);
    }
    return cited.join('\n');
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
    // A review sent as a diff (the CLI's) has no file content: the cited code
    // comes from the diff's new side and the window is the diff numbered by
    // head line, what the finder saw on main.
    if (content == null && file?.patch) {
        return {
            finding: {
                label: suggestion.label,
                relevantFile: suggestion.relevantFile,
                relevantLinesStart: suggestion.relevantLinesStart,
                relevantLinesEnd: suggestion.relevantLinesEnd,
                suggestionContent: suggestion.suggestionContent,
            },
            existingCode: citedFromPatch(file.patch, start, end),
            language: deterministic.language,
            fileWindow:
                file.patchWithLinesStr ||
                convertToUnifiedDiffWithLineNumbers(file.patch, file),
            filePatch: file.patch,
        };
    }
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
        /** The org the tokens are charged to. Required: a call without it is
         *  missing from the org's Token Usage and credits. */
        organizationId: string | undefined;
        /** Per-review attribution on each call's usage span. */
        usageAttrs?: Record<string, unknown>;
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
                    organizationId: opts.organizationId,
                    attrs: opts.usageAttrs,
                });
            } catch (error) {
                logger.warn({
                    message: `[ENRICH] enrichment call failed for ${s.relevantFile}:${s.relevantLinesStart ?? '?'}: ${(error as Error)?.message ?? String(error)}`,
                    context: 'EnrichSuggestions',
                    metadata: {
                        organizationId: opts.organizationId,
                        teamId: opts.usageAttrs?.teamId,
                        prNumber: opts.usageAttrs?.prNumber,
                    },
                });
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
