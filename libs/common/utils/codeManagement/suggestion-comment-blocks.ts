/**
 * Pieces every host builder renders a suggestion comment from: a bold title,
 * then the short body, then the fix inside a collapsed block. The visible
 * comment carries no code; the collapsed block is the copy-paste handoff to a
 * coding agent.
 */

/** Four backticks, so a ``` inside the fix cannot close the block early. */
const FENCE = '````';

export function formatTitleLine(title?: string | null): string {
    const text = title?.trim();
    return text ? `**${text}**\n\n` : '';
}

export function buildAgentPromptText(params: {
    path?: string;
    startLine?: number;
    endLine?: number;
    prompt?: string | null;
    improvedCode?: string | null;
}): string {
    const prompt = params.prompt?.trim();
    if (!prompt) return '';

    const parts: string[] = [];
    if (params.path) {
        const { startLine, endLine } = params;
        const where =
            startLine && endLine && startLine !== endLine
                ? `, lines ${startLine}-${endLine}`
                : endLine || startLine
                  ? `, line ${endLine || startLine}`
                  : '';
        parts.push(`File ${params.path}${where}:`);
    }
    parts.push(prompt);
    const code = params.improvedCode?.trim();
    if (code) parts.push(`Suggested code:\n\n${code}`);
    return parts.join('\n\n');
}

/**
 * The agent prompt for a suggestion: its llmPrompt, or, for a PR-level finding
 * that carries none, its title and whole explanation.
 */
export function resolveAgentPrompt(suggestion: {
    llmPrompt?: string;
    oneSentenceSummary?: string;
    fullExplanation?: string;
    suggestionContent?: string;
} | null | undefined): string {
    if (!suggestion) return '';
    if (suggestion.llmPrompt) return suggestion.llmPrompt;
    return [
        suggestion.oneSentenceSummary,
        suggestion.fullExplanation || suggestion.suggestionContent,
    ]
        .map((part) => part?.trim())
        .filter(Boolean)
        .join('\n\n');
}

const collapsed = (summary: string, content: string, language: string) =>
    `<details>\n<summary>${summary}</summary>\n\n${FENCE}${language}\n${content}\n${FENCE}\n\n</details>\n\n`;

/**
 * The collapsed block under the body: the full agent prompt when the team keeps
 * "Prompt for LLM" on, otherwise just the suggested code. Nothing when there is
 * neither.
 */
export function formatFixBlock(params: {
    copyPrompt: boolean;
    path?: string;
    startLine?: number;
    endLine?: number;
    prompt?: string | null;
    improvedCode?: string | null;
    language?: string | null;
}): string {
    if (params.copyPrompt) {
        const text = buildAgentPromptText(params);
        if (text) return collapsed('Prompt for LLM', text, 'text');
    }
    const code = params.improvedCode?.trim();
    if (!params.copyPrompt && code) {
        return collapsed(
            'Suggested fix',
            code,
            params.language?.toLowerCase() || '',
        );
    }
    return '';
}
