/**
 * #1821 experiment knob `leanOutput`: the generalist prompt asks each finding
 * only for file, lines, label and description, and submitResult requires only
 * file + content. Off must stay the production prompt and schema.
 */
import {
    buildUserPrompt,
    type PromptAgentMeta,
} from '@libs/code-review/infrastructure/agents/prompts/prompt-builder';
import { buildSubmitResultTool } from '@libs/code-review/infrastructure/agents/core/finder.agent';

const meta: PromptAgentMeta = {
    identity: { name: 'generalist', description: 'finds issues', goal: 'find issues', expertise: ['bugs'] },
    categoryPrompt: '<Category>generalist</Category>',
    categoryLabel: 'generalist',
    allowedLabels: ['bug', 'security', 'performance'],
    supportsMixed: true,
};
const input = (over: any = {}): any => ({
    remoteCommands: {},
    changedFiles: [{ filename: 'src/a.ts', patch: '@@ -1,1 +1,2 @@\n+const x = 1;' }],
    languageResultPrompt: 'en-US',
    prNumber: 1,
    ...over,
});
const outputBlock = (p: string) => p.slice(p.indexOf('<OutputFormat>'), p.indexOf('</OutputFormat>'));
const required = (t: ReturnType<typeof buildSubmitResultTool>) =>
    (t.inputSchema as any).properties.suggestions.items.required as string[];

describe('leanOutput', () => {
    it('off keeps the production output format and schema', () => {
        const out = outputBlock(buildUserPrompt(input(), meta));
        for (const f of ['"existingCode"', '"improvedCode"', '"severity"', '"confidence"', 'WHAT:']) expect(out).toContain(f);
        expect(required(buildSubmitResultTool())).toEqual(['relevantFile', 'suggestionContent', 'existingCode', 'improvedCode']);
        expect(required(buildSubmitResultTool(true))).toContain('reason');
    });

    it('on asks only for file, lines, label and description', () => {
        const out = outputBlock(buildUserPrompt(input({ leanOutput: true }), meta));
        for (const f of ['"existingCode"', '"improvedCode"', '"severity"', '"confidence"', 'WHAT:', '"language"', '"oneSentenceSummary"']) expect(out).not.toContain(f);
        for (const f of ['"reasoning"', '"relevantFile"', '"relevantLinesStart"', '"suggestionContent"', '"label"']) expect(out).toContain(f);
        expect(required(buildSubmitResultTool(false, false, false, true))).toEqual(['relevantFile', 'suggestionContent']);
    });

    it('on changes nothing outside the OutputFormat block', () => {
        const off = buildUserPrompt(input(), meta);
        const on = buildUserPrompt(input({ leanOutput: true }), meta);
        expect(on.replace(outputBlock(on), '')).toBe(off.replace(outputBlock(off), ''));
    });
});
