/**
 * Enrichment, model half (#1821): the title and the fix of a lean finding, in
 * one call (LLM.run) over the cited code, a numbered window of the file and
 * its diff. evals/enrichment also measures an agent loop with read tools
 * (evals/enrichment/with-tools.js). Severity is a separate step.
 */
import { z } from 'zod';

import { TITLE_PROMPT_SPEC } from '@libs/common/utils/codeManagement/suggestion-title';
import type { LangfuseTelemetryMetadata } from '@libs/core/log/langfuse';
import { LLM } from '@libs/llm/llm';
import type { NormalizedModel } from '@libs/llm/byok-config';
import {
    FIX_STATUSES,
    type FixStatus,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';

export { FIX_STATUSES, type FixStatus };

export type ContentEnrichment = {
    oneSentenceSummary: string;
    fixStatus: FixStatus;
    /** Replacement for exactly the cited lines; '' with `local` = delete them. */
    improvedCode: string;
};

export type EnrichmentInput = {
    finding: {
        label?: string;
        relevantFile?: string;
        relevantLinesStart?: number;
        relevantLinesEnd?: number;
        suggestionContent?: string;
    };
    existingCode: string;
    language: string;
    /** Numbered lines of the head file around the cited range. */
    fileWindow: string;
    filePatch: string;
};

const RESULT_ZOD = z.object({
    title: z.string(),
    fixStatus: z.enum(FIX_STATUSES),
    improvedCode: z.string(),
});

export const ENRICH_TASK = `You complete a code-review finding so it can be posted as a comment. The finding is a confirmed defect in a pull request; you receive its text, the file and the cited lines, the cited code, a numbered window of the file at the pull request head, and the file's diff.

Return:
- title: ${TITLE_PROMPT_SPEC}.
- fixStatus and improvedCode:
  - "local": improvedCode is the full replacement for EXACTLY the cited lines (relevantLinesStart..relevantLinesEnd), with the file's indentation, so that putting it in place of those lines fixes the defect. No line numbers, no diff markers, no markdown fence. An empty improvedCode means "delete the cited lines".
  - "needs-wider-change": a correct fix must also change code outside the cited lines.
  - "insufficient-context": you cannot write a correct fix without guessing names, signatures or behavior you have not seen.
  - "no-code-fix": the problem is not fixed by changing code.
  For every status other than "local", improvedCode is "".
Write a fix whenever you can write a correct one. Do not abstain to be safe, and do not guess.

Before choosing "needs-wider-change", look for a correct fix that fits inside the cited lines: a guard, a reordering, a wrapper, a small helper written inline. The fix the finding proposes is one option, not the only one.

A correct fix:
- fixes the whole defect: every case, input and path the finding names, not only the first one;
- keeps what the finding does not question: the other inputs, the existing checks, nil or empty values, the error handling around the cited lines;
- replaces exactly the cited lines: the lines right before and after them stay in the file unchanged, so do not repeat them, and do not open or close a block that one of them opens or closes.`;

const ONE_SHOT = `

Return only the JSON object {"title", "fixStatus", "improvedCode"}.`;

export function buildEnrichmentPrompt(
    input: EnrichmentInput,
): { system: string; user: string } {
    const f = input.finding;
    const user = [
        `<Finding>`,
        `label: ${f.label ?? ''}`,
        `file: ${f.relevantFile ?? ''}`,
        `cited lines: ${f.relevantLinesStart ?? '?'}-${f.relevantLinesEnd ?? f.relevantLinesStart ?? '?'}`,
        `text: ${f.suggestionContent ?? ''}`,
        `</Finding>`,
        ``,
        `<CitedCode language="${input.language}">`,
        input.existingCode || '(not available)',
        `</CitedCode>`,
        ``,
        `<FileWindow>`,
        input.fileWindow || '(not available)',
        `</FileWindow>`,
        ``,
        `<FileDiff>`,
        input.filePatch || '(not available)',
        `</FileDiff>`,
    ].join('\n');
    return { system: ENRICH_TASK + ONE_SHOT, user };
}

/** Normalizes a model answer; null when it is not one. */
export function parseEnrichment(raw: unknown): ContentEnrichment | null {
    const r = RESULT_ZOD.safeParse(raw);
    if (!r.success) return null;
    const local = r.data.fixStatus === 'local';
    return {
        oneSentenceSummary: r.data.title.trim(),
        fixStatus: r.data.fixStatus,
        improvedCode: local ? stripFence(r.data.improvedCode) : '',
    };
}

function stripFence(code: string): string {
    const m = /^```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(code.trim());
    return m ? m[1] : code;
}

/** One enrichment call; past it the suggestion keeps its cited code. */
const ENRICH_TIMEOUT_MS = 120_000;

export async function enrichOneShot(
    input: EnrichmentInput,
    opts: {
        byokConfig?: NormalizedModel;
        prebuiltModel?: unknown;
        telemetryMetadata?: LangfuseTelemetryMetadata;
        runName?: string;
        /** Puts the call's tokens on the org's Token Usage and credits.
         *  Required, so no caller leaves it out by accident. */
        organizationId: string | undefined;
        /** Per-review attribution on the usage span (teamId, prNumber). */
        attrs?: Record<string, unknown>;
    },
): Promise<ContentEnrichment | null> {
    const { system, user } = buildEnrichmentPrompt(input);
    const out = await LLM.run({
        system,
        user,
        schema: RESULT_ZOD,
        byokConfig: opts.byokConfig,
        prebuiltModel: opts.prebuiltModel as any,
        telemetryMetadata: opts.telemetryMetadata,
        runName: opts.runName ?? 'code-review-enrich',
        timeoutMs: ENRICH_TIMEOUT_MS,
        organizationId: opts.organizationId,
        attrs: opts.attrs,
    } as any);
    return parseEnrichment(out);
}
