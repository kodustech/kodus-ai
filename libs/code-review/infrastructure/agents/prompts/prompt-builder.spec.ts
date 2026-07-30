/**
 * prompt-builder unit tests — pure string building, zero LLM/IO.
 * Locks the key structural invariants of each prompt variant so a future
 * edit that silently drops a section is caught.
 */
import {
    buildSystemPrompt,
    buildUserPrompt,
    type PromptAgentMeta,
} from '@libs/code-review/infrastructure/agents/prompts/prompt-builder';

const meta: PromptAgentMeta = {
    identity: {
        name: 'bug-agent',
        description: 'finds bugs',
        goal: 'find bugs',
        expertise: ['bugs'],
    },
    categoryPrompt: '<Category>bugs</Category>',
    categoryLabel: 'bug',
    allowedLabels: ['bug'],
    supportsMixed: false,
};

const file = (filename: string, patch: string): any => ({ filename, patch });

const baseInput = (over: any = {}): any => ({
    remoteCommands: {}, // truthy → NOT self-contained
    changedFiles: [file('src/a.ts', '@@ -1,1 +1,2 @@\n+const x = 1;')],
    languageResultPrompt: 'en-US',
    prNumber: 1,
    ...over,
});

describe('buildSystemPrompt', () => {
    it('full prompt includes the Workflow walk-through + category', () => {
        const sys = buildSystemPrompt(baseInput(), meta);
        expect(sys).toContain('<Workflow>');
        expect(sys).toContain('PHASE 1 — INVESTIGATE');
        expect(sys).toContain('<Category>bugs</Category>');
    });

    it('compact profile drops the Workflow walk-through', () => {
        const sys = buildSystemPrompt(
            baseInput({ adaptiveProfile: { compactPrompt: true } }),
            meta,
        );
        expect(sys).not.toContain('PHASE 1 — INVESTIGATE');
        expect(sys).toContain('<Role>');
    });

    it('self-contained (no sandbox) forbids caller claims', () => {
        const sys = buildSystemPrompt(
            baseInput({ remoteCommands: undefined }),
            meta,
        );
        expect(sys).toContain('mode="self-contained"');
        expect(sys).toContain('you cannot see callers');
    });
});

describe('buildUserPrompt', () => {
    it('full prompt renders the diffs + coverage contract + rules', () => {
        const user = buildUserPrompt(baseInput(), meta);
        expect(user).toContain('<Diffs>');
        expect(user).toContain('src/a.ts');
        expect(user).toContain('<CoverageContract>');
        expect(user).toContain('<Rules>');
    });

    it('mixed reviewer surfaces the per-category label guidance', () => {
        const mixedMeta: PromptAgentMeta = {
            ...meta,
            categoryLabel: 'generalist',
            allowedLabels: ['bug', 'security', 'performance'],
            supportsMixed: true,
        };
        const user = buildUserPrompt(baseInput(), mixedMeta);
        expect(user).toContain('bug, security, performance');
    });
});
