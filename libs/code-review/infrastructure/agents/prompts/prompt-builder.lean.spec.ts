/**
 * #1821: the finder's output is lean. Every generalist prompt variant asks each
 * finding only for label, file, lines and description, and submitResult
 * requires exactly those fields; snippet, fix, severity and confidence are
 * added by a later enrichment stage.
 */
import {
    buildCompactUserPrompt,
    buildSelfContainedSystemPrompt,
    buildSelfContainedUserPrompt,
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
const LEGACY = ['"existingCode"', '"improvedCode"', '"oneSentenceSummary"', '"language"', '"severity"', '"confidence"', 'WHAT:'];
const required = (t: ReturnType<typeof buildSubmitResultTool>) =>
    (t.inputSchema as any).properties.suggestions.items.required as string[];

describe('lean finder output', () => {
    it('the full and self-contained prompts ask only for label, file, lines and description', () => {
        for (const p of [buildUserPrompt(input(), meta), buildSelfContainedUserPrompt(input(), meta)]) {
            const out = outputBlock(p);
            for (const f of LEGACY) expect(out).not.toContain(f);
            for (const f of ['"reasoning"', '"label"', '"relevantFile"', '"relevantLinesStart"', '"relevantLinesEnd"', '"suggestionContent"']) {
                expect(out).toContain(f);
            }
        }
    });

    it('no variant asks for confidence or severity', () => {
        for (const p of [
            buildUserPrompt(input(), meta),
            buildUserPrompt(input({ noImportanceFilter: true }), meta),
            buildCompactUserPrompt(input(), meta),
            buildSelfContainedSystemPrompt(input(), meta),
            buildSelfContainedUserPrompt(input(), meta),
        ]) {
            expect(p).not.toMatch(/confidence score|Assign confidence|"severity"|severity" says/i);
        }
    });

    it('shows the label even for a single-category agent', () => {
        const single = { ...meta, categoryLabel: 'bug', allowedLabels: ['bug'], supportsMixed: false } as PromptAgentMeta;
        expect(outputBlock(buildUserPrompt(input(), single))).toContain('"label": "bug"');
    });

    it('submitResult requires exactly the lean fields, nothing optional', () => {
        const tool = buildSubmitResultTool();
        const fields = ['label', 'relevantFile', 'relevantLinesStart', 'relevantLinesEnd', 'suggestionContent'];
        expect(required(tool)).toEqual(fields);
        expect(Object.keys((tool.inputSchema as any).properties.suggestions.items.properties).sort()).toEqual([...fields].sort());
        expect(required(buildSubmitResultTool(true))).toContain('reason');
    });
});
