/**
 * code-review (domain) — context-fit sizing & chunking.
 *
 * Pure functions extracted from BaseCodeReviewAgentProvider (Phase 1 of the
 * provider decomposition). They answer ONE question: "does this review fit the
 * model's context window, and if not, how do we make it fit?" — token
 * estimation, the preflight overhead guard, large-PR filtering, and diff
 * chunking. No NestJS, no I/O, no LLM — trivially unit-testable.
 */
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { AgentContextWindowTooSmallError } from '@libs/llm/errors';
import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';

import { type AdaptiveProfile } from '@libs/code-review/infrastructure/agents/engine/adaptive-fit';
import { CoverageTier } from '@libs/code-review/infrastructure/agents/engine/coverage-ledger';

/** Rough token estimate: 1 token ≈ 4 characters */
export const CHARS_PER_TOKEN = 4;
/**
 * Ceiling on the ESTIMATED full prompt (not just diffs) as a fraction of
 * the model context window. At 0.55 we reserve ~45% of the window for
 * accumulated tool results, LLM reasoning, and response — which in
 * practice is the minimum headroom needed to keep the main loop from
 * starting at >70% utilization in PRs with hundreds of files.
 */
export const PROMPT_BUDGET_RATIO = 0.55;
/**
 * Everything in the prompt that isn't the diff content itself:
 * system prompt (~22K chars), tool schemas (~40K chars), PR context,
 * and coverage target list. Kept as a char constant because it's used
 * to reduce the per-chunk diff budget when we split.
 */
export const PROMPT_STATIC_OVERHEAD_CHARS = 62_000;
/**
 * Static overhead when the compact prompt path fires (adaptive-fit
 * `compact+` profiles). Measured empirically from the post-fix benchmark:
 * the compact system + user prompt strings drop ~14K chars (saving
 * ~3.5K tokens of the system prompt + the OutputFormat block + the
 * trimmed Rules). The 40K-char tool-schema block is untouched (we
 * deliberately don't reduce the toolset). 62K - 14K = 48K chars ≈ 12K
 * tokens of overhead, which gives 16K models ~4K of headroom for diffs.
 */
export const PROMPT_STATIC_OVERHEAD_CHARS_COMPACT = 48_000;

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
 * Preflight guard: when the agent's static overhead (system prompt +
 * tool schemas + coverage list + PR context) already exceeds the
 * model's context window, no PR can ever fit and the LLM call would
 * fail immediately with a 4xx. Without this check the agent silently
 * hangs until AGENT_TIMEOUT_MS (30 min) — see runAgentLoop's setTimeout
 * — burning a queue slot and producing zero output.
 *
 * Exported so it can be unit-tested in isolation. Called from
 * BaseCodeReviewAgentProvider.execute right after resolveContextWindow.
 */
export function assertContextWindowFitsOverhead(params: {
    input: {
        changedFiles?: FileChange[];
        callGraph?: string;
        prTitle?: string;
        prBody?: string;
        adaptiveProfile?: AdaptiveProfile;
    };
    contextWindow: number;
    modelName: string;
}): void {
    const overheadTokens = estimateNonDiffOverheadTokens(params.input);

    if (overheadTokens >= params.contextWindow) {
        throw new AgentContextWindowTooSmallError({
            contextWindow: params.contextWindow,
            overheadTokens,
            modelName: params.modelName,
        });
    }
}

export function estimateDiffTokens(files: FileChange[]): number {
    return files.reduce((sum, f) => {
        const diff = f.patchWithLinesStr ?? f.patch ?? '';
        return sum + Math.ceil(diff.length / CHARS_PER_TOKEN);
    }, 0);
}

/**
 * Total non-diff overhead in tokens: static (system prompt + tool schemas)
 * plus dynamic (callGraph + coverage list + PR context). Reused by both
 * estimatePromptTokens and the per-chunk budget calc so the split decision
 * and chunk sizing can't drift — when they did, a ~2% prompt overflow
 * still produced a chunker that packed every file into one chunk because
 * the chunk budget subtracted only the static part.
 */
export function estimateNonDiffOverheadTokens(input: {
    changedFiles?: FileChange[];
    callGraph?: string;
    prTitle?: string;
    prBody?: string;
    adaptiveProfile?: AdaptiveProfile;
}): number {
    // Adaptive fit: when the compact prompt path will fire, the system
    // + user prompt are ~14K chars smaller. Counting the full 62K
    // overhead would cause the preflight to throw before the compact
    // path even has a chance to render — exactly the bug observed on
    // the post-fix 16K benchmark run where every PR preflight-failed
    // despite the strategies being wired correctly.
    const staticOverheadChars = input.adaptiveProfile?.compactPrompt
        ? PROMPT_STATIC_OVERHEAD_CHARS_COMPACT
        : PROMPT_STATIC_OVERHEAD_CHARS;
    // CallGraph: if the profile drops it from the prompt, the estimator
    // must drop it too. Otherwise the preflight blames overhead the
    // user will never actually pay.
    const callGraphChars = input.adaptiveProfile?.dropCallGraph
        ? 0
        : (input.callGraph || '').length;
    const prBodyChars = Math.min((input.prBody || '').length, 500);
    const prContextChars = 300 + (input.prTitle || '').length + prBodyChars;
    const coverageListChars = (input.changedFiles?.length || 0) * 80;
    const totalChars =
        callGraphChars +
        prContextChars +
        coverageListChars +
        staticOverheadChars;
    return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

/**
 * Estimate of the full input token count for the first LLM call:
 * diff content + callGraph + PR context + per-file coverage lines +
 * static overhead (system prompt + tool schemas).
 */
export function estimatePromptTokens(input: {
    changedFiles?: FileChange[];
    callGraph?: string;
    prTitle?: string;
    prBody?: string;
    fileTiers?: Map<string, CoverageTier>;
    adaptiveProfile?: AdaptiveProfile;
}): number {
    const tiers = input.fileTiers;
    const diffChars = (input.changedFiles || []).reduce((sum, f) => {
        const diff = f.patchWithLinesStr ?? f.patch ?? '';
        if (tiers) {
            const tier = tiers.get(normalizeFilenameForTier(f.filename));
            if (tier === 'optional') {
                // Optional files are rendered as hunk headers only,
                // so their prompt footprint collapses to the hunk count
                // plus the filename header (~60 chars per hunk + ~120
                // for the file header).
                return sum + estimateHunkHeaderChars(diff);
            }
        }
        return sum + diff.length;
    }, 0);
    const diffTokens = Math.ceil(diffChars / CHARS_PER_TOKEN);
    return diffTokens + estimateNonDiffOverheadTokens(input);
}

export function normalizeFilenameForTier(filename?: string): string {
    if (!filename) {
        return '';
    }
    return filename.replace(/^\/+/, '').replace(/\\/g, '/').trim();
}

export function estimateHunkHeaderChars(diff: string): number {
    if (!diff) {
        return 0;
    }
    let hunkCount = 0;
    for (const line of diff.split('\n')) {
        if (line.startsWith('@@ ')) {
            hunkCount++;
        }
    }
    return 120 + hunkCount * 60; // file header + per-hunk line
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
        const diff = file.patchWithLinesStr ?? file.patch ?? '';
        const fileTokens = Math.ceil(diff.length / CHARS_PER_TOKEN);

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
