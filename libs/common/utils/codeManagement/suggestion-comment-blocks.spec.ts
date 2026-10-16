import {
    buildAgentPromptText,
    formatFixBlock,
    formatTitleLine,
} from './suggestion-comment-blocks';

describe('formatTitleLine', () => {
    it('renders the title in bold on its own paragraph', () => {
        expect(formatTitleLine('User can be null')).toBe('**User can be null**\n\n');
    });

    it('renders nothing without a title', () => {
        expect(formatTitleLine('')).toBe('');
        expect(formatTitleLine(undefined)).toBe('');
    });
});

describe('buildAgentPromptText', () => {
    it('names the file and line range, then the prompt, then the suggested code', () => {
        expect(
            buildAgentPromptText({
                path: 'src/user.ts',
                startLine: 10,
                endLine: 12,
                prompt: 'User can be null\n\nThe whole explanation.',
                improvedCode: 'const name = user?.name;',
            }),
        ).toBe(
            'File src/user.ts, lines 10-12:\n\nUser can be null\n\nThe whole explanation.\n\nSuggested code:\n\nconst name = user?.name;',
        );
    });

    it('handles a single line, no file and no code', () => {
        expect(
            buildAgentPromptText({ path: 'a.ts', endLine: 3, prompt: 'P' }),
        ).toBe('File a.ts, line 3:\n\nP');
        expect(buildAgentPromptText({ prompt: 'P' })).toBe('P');
    });

    it('returns nothing without a prompt', () => {
        expect(buildAgentPromptText({ path: 'a.ts', prompt: '' })).toBe('');
    });
});

describe('formatFixBlock', () => {
    const base = {
        path: 'src/user.ts',
        startLine: 10,
        endLine: 12,
        prompt: 'User can be null\n\nThe whole explanation.',
        improvedCode: 'const name = user?.name;',
        language: 'typescript',
    };

    it('puts the agent prompt, fix included, in a collapsed block fenced with four backticks', () => {
        const block = formatFixBlock({ ...base, copyPrompt: true });

        expect(block).toContain('<details>\n<summary>Prompt for LLM</summary>\n\n````text\n');
        expect(block).toContain('Suggested code:\n\nconst name = user?.name;\n````\n\n</details>');
        expect(block).not.toMatch(/````text\n\n/);
    });

    it('survives a fix that contains a triple-backtick fence', () => {
        const block = formatFixBlock({
            ...base,
            improvedCode: '/** ```js\nx()\n``` */\nconst y = 1;',
            copyPrompt: true,
        });

        expect(block.trimEnd().endsWith('````\n\n</details>')).toBe(true);
    });

    it('falls back to a collapsed "Suggested fix" with only the code when the prompt is off', () => {
        const block = formatFixBlock({ ...base, copyPrompt: false });

        expect(block).toBe(
            '<details>\n<summary>Suggested fix</summary>\n\n````typescript\nconst name = user?.name;\n````\n\n</details>\n\n',
        );
    });

    it('renders nothing with the prompt off and no fix', () => {
        expect(formatFixBlock({ ...base, improvedCode: '', copyPrompt: false })).toBe('');
    });
});
