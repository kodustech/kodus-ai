import { estimateTokens, tokensToChars } from './token-estimator';

const CUT_MARKER = '<- CUT CONTENT ->';

export interface SplitResult {
    chunks: string[];
    wasSplit: boolean;
}

export function splitFileContent(params: {
    content: string;
    maxInputTokens: number;
    fixedTokens: number;
    hasASTMarkers: boolean;
}): SplitResult {
    const { content, maxInputTokens, fixedTokens, hasASTMarkers } = params;

    // Apply 10% safety margin
    const effectiveBudget = Math.floor(maxInputTokens * 0.9);
    const availableTokens = effectiveBudget - fixedTokens;

    if (availableTokens <= 0) {
        // Budget consumed by fixed parts alone — send full content best-effort
        return { chunks: [content], wasSplit: false };
    }

    const contentTokens = estimateTokens(content);

    // File fits in budget — no split needed
    if (contentTokens <= availableTokens) {
        return { chunks: [content], wasSplit: false };
    }

    const maxCharsPerChunk = tokensToChars(availableTokens);

    // Check if min 25% fits (max 4 chunks rule)
    const minChunkTokens = Math.ceil(contentTokens / 4);
    if (minChunkTokens > availableTokens) {
        // Even 25% doesn't fit — send full content best-effort
        return { chunks: [content], wasSplit: false };
    }

    const rawChunks = hasASTMarkers
        ? splitAtASTMarkers(content, maxCharsPerChunk)
        : splitByCharacters(content, maxCharsPerChunk);

    // Cap at 4 chunks
    const chunks = rawChunks.slice(0, 4);

    return { chunks, wasSplit: chunks.length > 1 };
}

export function estimateFixedTokens(params: {
    patchWithLinesStr?: string;
    prSummary?: string;
    crossFileSnippets?: {
        content: string;
        filePath: string;
        rationale: string;
        relatedSymbol?: string;
    }[];
    systemPromptOverhead?: number;
}): number {
    const {
        patchWithLinesStr,
        prSummary,
        crossFileSnippets,
        systemPromptOverhead = 5000,
    } = params;

    let total = systemPromptOverhead; // base system prompt
    total += 200; // user prompt wrapper text (markdown, headings, code fences etc.)
    total += estimateTokens(patchWithLinesStr || '');
    total += estimateTokens(prSummary || '');

    if (crossFileSnippets?.length) {
        for (const snippet of crossFileSnippets) {
            total += estimateTokens(snippet.content || '');
            total += estimateTokens(snippet.filePath || '');
            total += estimateTokens(snippet.rationale || '');
            total += 50; // markdown formatting per snippet
        }
    }

    return total;
}

function splitAtASTMarkers(
    content: string,
    maxCharsPerChunk: number,
): string[] {
    const sections = content.split(CUT_MARKER);
    const chunks: string[] = [];
    let current = '';

    for (const section of sections) {
        const candidate = current ? current + CUT_MARKER + section : section;

        if (candidate.length <= maxCharsPerChunk || !current) {
            current = candidate;
        } else {
            chunks.push(current);
            current = section;
        }
    }
    if (current) chunks.push(current);

    return chunks;
}

function splitByCharacters(
    content: string,
    maxCharsPerChunk: number,
): string[] {
    const chunks: string[] = [];
    const lines = content.split('\n');
    let current = '';

    for (const line of lines) {
        const candidate = current ? current + '\n' + line : line;
        if (candidate.length > maxCharsPerChunk && current) {
            chunks.push(current);
            current = line;
        } else {
            current = candidate;
        }
    }
    if (current) chunks.push(current);

    return chunks;
}
