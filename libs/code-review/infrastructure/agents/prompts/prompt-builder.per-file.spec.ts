/**
 * #1821 experiment knob `perFileVerdicts`: only the `reasoning` instruction and
 * one rule change. Off must stay the production prompt word for word.
 */
import {
    buildUserPrompt,
    type PromptAgentMeta,
} from '@libs/code-review/infrastructure/agents/prompts/prompt-builder';

const meta: PromptAgentMeta = {
    identity: {
        name: 'generalist',
        description: 'finds issues',
        goal: 'find issues',
        expertise: ['bugs'],
    },
    categoryPrompt: '<Category>generalist</Category>',
    categoryLabel: 'generalist',
    allowedLabels: ['bug', 'security', 'performance'],
    supportsMixed: true,
};

const input = (over: any = {}): any => ({
    remoteCommands: {},
    changedFiles: [
        { filename: 'src/a.ts', patch: '@@ -1,1 +1,2 @@\n+const x = 1;' },
        { filename: 'src/b.ts', patch: '@@ -1,1 +1,2 @@\n+const y = 2;' },
    ],
    languageResultPrompt: 'en-US',
    prNumber: 1,
    ...over,
});

const PRODUCTION_REASONING =
    'For each changed function: what you challenged, what callers you found, why you reported or dismissed.';

describe('buildUserPrompt perFileVerdicts', () => {
    it('off (default) keeps the production reasoning instruction and no extra rule', () => {
        const user = buildUserPrompt(input(), meta);
        expect(user).toContain(PRODUCTION_REASONING);
        expect(user).not.toContain('Deliver file by file');
        expect(user).toBe(buildUserPrompt(input({ perFileVerdicts: false }), meta));
    });

    it('on asks for one verdict per changed file and ties verdicts to suggestions', () => {
        const user = buildUserPrompt(input({ perFileVerdicts: true }), meta);
        expect(user).not.toContain(PRODUCTION_REASONING);
        expect(user).toContain('One line per changed file');
        expect(user).toContain('Deliver file by file');
        expect(user).toContain('"suggestions": [');
    });

    it('on changes nothing outside the reasoning line and the new rule', () => {
        const off = buildUserPrompt(input(), meta).split('\n');
        const on = buildUserPrompt(input({ perFileVerdicts: true }), meta).split('\n');
        const onlyOff = off.filter((l) => !on.includes(l));
        const onlyOn = on.filter((l) => !off.includes(l));
        expect(onlyOff).toHaveLength(1);
        expect(onlyOff.some((l) => l.includes(PRODUCTION_REASONING))).toBe(true);
        expect(onlyOn.some((l) => l.includes('One line per changed file'))).toBe(true);
        expect(onlyOn.some((l) => l.includes('Deliver file by file'))).toBe(true);
    });

    it('noImportanceFilter adds one rule and nothing else; off keeps the production prompt', () => {
        const off = buildUserPrompt(input({ perFileVerdicts: true }), meta);
        const on = buildUserPrompt(input({ perFileVerdicts: true, noImportanceFilter: true }), meta);
        expect(off).not.toContain('too minor to report');
        expect(on).toContain('too minor to report');
        const added = on.split('\n').filter((l) => !off.split('\n').includes(l));
        expect(added).toHaveLength(1);
        expect(buildUserPrompt(input(), meta)).not.toContain('too minor to report');
    });
});
