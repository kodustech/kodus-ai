/**
 * #1821 experiment knob `auditorRole`: swaps only the generalist's role and
 * mission sentences. Off must stay the production system prompt.
 */
import {
    AUDITOR_ROLE_SWAPS,
    buildSystemPrompt,
    type PromptAgentMeta,
} from '@libs/code-review/infrastructure/agents/prompts/prompt-builder';
import { buildGeneralistReviewPrompt } from '@libs/code-review/infrastructure/agents/prompts/review-prompt-blocks';

const meta: PromptAgentMeta = {
    identity: {
        name: 'kodus-generalist-review-agent',
        description:
            'Senior code reviewer specialized in finding correctness, security, and performance issues in one pass. Investigates the diff and surrounding code before reporting.',
        goal: 'find issues',
        expertise: ['bugs'],
    },
    categoryPrompt: buildGeneralistReviewPrompt(),
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

describe('buildSystemPrompt auditorRole', () => {
    it('off keeps both production sentences', () => {
        const sys = buildSystemPrompt(input(), meta);
        for (const [from, to] of AUDITOR_ROLE_SWAPS) {
            expect(sys).toContain(from);
            expect(sys).not.toContain(to);
        }
    });

    it('on swaps exactly the two sentences and nothing else', () => {
        const off = buildSystemPrompt(input(), meta);
        const on = buildSystemPrompt(input({ auditorRole: true }), meta);
        for (const [from, to] of AUDITOR_ROLE_SWAPS) {
            expect(on).not.toContain(from);
            expect(on).toContain(to);
        }
        const back = AUDITOR_ROLE_SWAPS.reduce((p, [from, to]) => p.replace(to, from), on);
        expect(back).toBe(off);
    });
});
