/**
 * code-review (domain) — context-fit sizing & chunking.
 *
 * Pure functions extracted from BaseCodeReviewAgentProvider (Phase 1 of the
 * provider decomposition). They answer ONE question: "does this review fit the
 * model's context window, and if not, how do we make it fit?" — diff token
 * counts, the preflight overhead guard, large-PR filtering, and diff
 * chunking. The non-diff overhead is measured by the provider, which owns
 * the prompts and tools. No NestJS, no I/O, no LLM.
 */
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { AgentContextWindowTooSmallError } from '@libs/llm/errors';
import { estimateTextTokens } from '@libs/llm/token-estimate';
import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';

import { type AdaptiveProfile } from '@libs/code-review/infrastructure/agents/engine/adaptive-fit';

/**
 * One file's diff in tokens, counted once per file. A flat 4 chars/token
 * undercounted dense diffs (line-numbered data runs 2.6-3.0 on DeepSeek), so
 * batches at 128K went past the budget; `o200k` stays within 3% of DeepSeek
 * per file. The cache keeps the planner's repeated walks from re-tokenizing.
 */
const diffTokenCache = new WeakMap<
    FileChange,
    { diff: string; tokens: number }
>();

export function fileDiffTokens(file: FileChange): number {
    const diff = file.patchWithLinesStr ?? file.patch ?? '';
    const cached = diffTokenCache.get(file);
    if (cached && cached.diff === diff) {
        return cached.tokens;
    }
    const tokens = estimateTextTokens(diff);
    diffTokenCache.set(file, { diff, tokens });
    return tokens;
}

/**
 * Ceiling on the ESTIMATED full prompt (not just diffs) as a fraction of
 * the model context window. At 0.55 we reserve ~45% of the window for
 * accumulated tool results, LLM reasoning, and response — which in
 * practice is the minimum headroom needed to keep the main loop from
 * starting at >70% utilization in PRs with hundreds of files.
 */
export const PROMPT_BUDGET_RATIO = 0.55;
/**
 * Low-signal glob patterns dropped from changedFiles only when a large PR
 * is reviewed in non-deep mode. Tests, docs, and pure styles rarely carry
 * the kinds of findings the agent targets, and keeping them in the diff
 * budget crowds out real production code.
 */
export const LARGE_PR_AGGRESSIVE_FILTER_PATTERNS = [
    '**/*.spec.*',
    '**/*.test.*',
    '**/test/**',
    '**/tests/**',
    '**/__tests__/**',
    '**/*.md',
    '**/*.css',
    '**/*.scss',
];

/**
 * Preflight guard: when the prompt without any diff (system prompt, tool
 * schemas, PR context, coverage list, callGraph) already fills what the
 * model can take, no batch can fit and every LLM call would fail with a 4xx.
 * Without this check the agent silently hangs until AGENT_TIMEOUT_MS
 * (30 min) — see runAgentLoop's setTimeout — burning a queue slot and
 * producing zero output.
 *
 * `overheadTokens` is measured from the prompts this run will send, so the
 * number the user sees is the real size of the fixed prompt.
 */
export function assertContextWindowFitsOverhead(params: {
    overheadTokens: number;
    adaptiveProfile?: AdaptiveProfile;
    contextWindow: number;
    modelName: string;
}): void {
    const { overheadTokens } = params;

    // On a small window, overhead past the prompt budget leaves no room
    // for a batch's diff and the answer: every batch would overflow. A
    // full-size window keeps the whole window as the limit, so a huge
    // callGraph still runs as one batch.
    const smallWindow =
        !!params.adaptiveProfile && params.adaptiveProfile.kind !== 'full';
    const limit = smallWindow
        ? Math.floor(params.contextWindow * PROMPT_BUDGET_RATIO)
        : params.contextWindow;
    if (overheadTokens >= limit) {
        throw new AgentContextWindowTooSmallError({
            contextWindow: params.contextWindow,
            overheadTokens,
            modelName: params.modelName,
        });
    }
}

export function estimateDiffTokens(files: FileChange[]): number {
    return files.reduce((sum, f) => sum + fileDiffTokens(f), 0);
}

/**
 * Estimate of the full input token count for the first LLM call: every
 * file's diff, sent whole whatever its tier (#2652), plus the measured
 * non-diff part of the prompt.
 */
export function estimatePromptTokens(
    files: FileChange[],
    overheadTokens: number,
): number {
    return estimateDiffTokens(files) + overheadTokens;
}

export function normalizeFilenameForTier(filename?: string): string {
    if (!filename) {
        return '';
    }
    return filename.replace(/^\/+/, '').replace(/\\/g, '/').trim();
}

export function extractHunkHeaders(diff: string): string[] {
    if (!diff) {
        return [];
    }
    const headers: string[] = [];
    for (const line of diff.split('\n')) {
        if (line.startsWith('@@ ')) {
            headers.push(line);
        }
    }
    return headers;
}

export function applyLargePrAggressiveFilter(
    files: FileChange[],
): FileChange[] {
    return files.filter(
        (f) =>
            !isFileMatchingGlob(
                f.filename,
                LARGE_PR_AGGRESSIVE_FILTER_PATTERNS,
            ),
    );
}

export function chunkFilesByTokenBudget(
    files: FileChange[],
    budgetTokens: number,
): FileChange[][] {
    if (files.length === 0) {
        return [[]];
    }

    const chunks: FileChange[][] = [];
    let currentChunk: FileChange[] = [];
    let currentTokens = 0;

    for (const file of files) {
        const fileTokens = fileDiffTokens(file);

        // If a single file exceeds the budget, give it its own chunk
        if (fileTokens > budgetTokens) {
            if (currentChunk.length > 0) {
                chunks.push(currentChunk);
                currentChunk = [];
                currentTokens = 0;
            }
            chunks.push([file]);
            continue;
        }

        if (
            currentTokens + fileTokens > budgetTokens &&
            currentChunk.length > 0
        ) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentTokens = 0;
        }

        currentChunk.push(file);
        currentTokens += fileTokens;
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
}
