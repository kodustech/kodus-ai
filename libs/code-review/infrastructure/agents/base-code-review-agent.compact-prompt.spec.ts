/**
 * Verifies the adaptive-fit compact prompt path produces a meaningfully
 * smaller prompt than the full path while keeping the load-bearing
 * pieces (role, mindset, scope).
 *
 * We hit the private methods via a thin test subclass — there's no
 * other observable seam that lets us measure prompt size in isolation.
 */

import { resolveAdaptiveProfile } from './llm/adaptive-fit';
import {
    BaseCodeReviewAgentProvider,
    type ReviewAgentInput,
    type ReviewAgentIdentity,
} from './base-code-review-agent.provider';

class TestAgent extends BaseCodeReviewAgentProvider {
    constructor() {
        super(null as any, null as any, null as any);
    }
    protected getIdentity(): ReviewAgentIdentity {
        return {
            name: 'TestAgent',
            description: 'a test reviewer',
        } as ReviewAgentIdentity;
    }
    protected getCategoryPrompt(): string {
        return 'Long category-specific prompt with many lines of guidance about how to find bugs and report findings carefully and so on. '.repeat(
            30,
        );
    }
    protected getCategoryLabel(): string {
        return 'bug';
    }
    // Expose the private build methods through public test hooks.
    public buildSystemPromptForTest(input: ReviewAgentInput): string {
        return (this as any).buildSystemPrompt(input);
    }
    public buildUserPromptForTest(input: ReviewAgentInput): string {
        return (this as any).buildUserPrompt(input);
    }
}

const makeInput = (
    overrides: Partial<ReviewAgentInput> = {},
): ReviewAgentInput => ({
    organizationAndTeamData: { organizationId: 'o', teamId: 't' } as any,
    changedFiles: [{ filename: 'foo.ts', patch: '+ a\n- b\n' } as any],
    prNumber: 1,
    repositoryFullName: 'kodus/test',
    languageResultPrompt: 'en-US',
    remoteCommands: {} as any, // not self-contained
    ...overrides,
});

describe('Adaptive-fit compact prompt path', () => {
    const agent = new TestAgent();

    it('compact system prompt is at least 50% smaller than full', () => {
        const full = agent.buildSystemPromptForTest(makeInput());
        const compact = agent.buildSystemPromptForTest(
            makeInput({ adaptiveProfile: resolveAdaptiveProfile(16_000) }),
        );
        expect(compact.length).toBeLessThan(full.length * 0.5);
    });

    it('compact system prompt keeps Role and Scope (load-bearing)', () => {
        const compact = agent.buildSystemPromptForTest(
            makeInput({ adaptiveProfile: resolveAdaptiveProfile(16_000) }),
        );
        expect(compact).toContain('<Role>');
        expect(compact).toContain('<Scope>');
        expect(compact).toContain('TestAgent');
    });

    it('compact system prompt drops the Workflow walk-through (PHASE 1/2/3)', () => {
        const full = agent.buildSystemPromptForTest(makeInput());
        const compact = agent.buildSystemPromptForTest(
            makeInput({ adaptiveProfile: resolveAdaptiveProfile(16_000) }),
        );
        expect(full).toContain('PHASE 1');
        expect(compact).not.toContain('PHASE 1');
    });

    it('compact user prompt drops <OutputFormat> JSON example', () => {
        const full = agent.buildUserPromptForTest(makeInput());
        const compact = agent.buildUserPromptForTest(
            makeInput({ adaptiveProfile: resolveAdaptiveProfile(16_000) }),
        );
        expect(full).toContain('<OutputFormat>');
        expect(compact).not.toContain('<OutputFormat>');
        // <Diffs> is the actual data — must stay.
        expect(compact).toContain('<Diffs>');
    });

    it('full profile (no adaptiveProfile) keeps the original prompt unchanged', () => {
        const full = agent.buildSystemPromptForTest(makeInput());
        const profileFull = agent.buildSystemPromptForTest(
            makeInput({ adaptiveProfile: resolveAdaptiveProfile(128_000) }),
        );
        expect(full).toEqual(profileFull);
    });
});
