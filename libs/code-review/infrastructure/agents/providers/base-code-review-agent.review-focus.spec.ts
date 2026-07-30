/**
 * Verifies the `@kody review <directive>` steering text is rendered into the
 * finder prompt as a high-priority <ReviewFocus> block — on both the full and
 * compact user-prompt paths — and that it is a PRIORITY hint, not a filter
 * (issues elsewhere are still in scope). Absent directive => no block.
 *
 * Hits the private build methods via a thin test subclass, matching
 * base-code-review-agent.compact-prompt.spec.ts.
 */

import { resolveAdaptiveProfile } from '@libs/code-review/infrastructure/agents/engine/adaptive-fit';
import { BaseCodeReviewAgentProvider } from '@libs/code-review/infrastructure/agents/providers/base-code-review-agent.provider';
import {
    type ReviewAgentInput,
    type ReviewAgentIdentity,
} from '@libs/code-review/infrastructure/agents/review-agent.contract';

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
        return 'category prompt';
    }
    protected getCategoryLabel(): string {
        return 'bug';
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

describe('Review focus directive prompt rendering', () => {
    const agent = new TestAgent();
    const DIRECTIVE = 'the authentication and session-handling logic';

    it('renders a <ReviewFocus> block carrying the directive when set', () => {
        const prompt = agent.buildUserPromptForTest(
            makeInput({ reviewDirective: DIRECTIVE }),
        );
        expect(prompt).toContain('<ReviewFocus>');
        expect(prompt).toContain('</ReviewFocus>');
        expect(prompt).toContain(DIRECTIVE);
    });

    it('places the focus block before the <Diffs> (read first)', () => {
        const prompt = agent.buildUserPromptForTest(
            makeInput({ reviewDirective: DIRECTIVE }),
        );
        expect(prompt.indexOf('<ReviewFocus>')).toBeGreaterThanOrEqual(0);
        expect(prompt.indexOf('<ReviewFocus>')).toBeLessThan(
            prompt.indexOf('<Diffs>'),
        );
    });

    it('is a priority hint, not a filter (still reports issues elsewhere)', () => {
        const prompt = agent.buildUserPromptForTest(
            makeInput({ reviewDirective: DIRECTIVE }),
        );
        const block = prompt.slice(
            prompt.indexOf('<ReviewFocus>'),
            prompt.indexOf('</ReviewFocus>'),
        );
        expect(block.toLowerCase()).toContain('do not suppress');
    });

    it('renders no focus block when no directive is set', () => {
        const prompt = agent.buildUserPromptForTest(makeInput());
        expect(prompt).not.toContain('<ReviewFocus>');
    });

    it('treats an empty/whitespace directive as no directive', () => {
        const prompt = agent.buildUserPromptForTest(
            makeInput({ reviewDirective: '   ' }),
        );
        expect(prompt).not.toContain('<ReviewFocus>');
    });

    it('also renders the focus block on the compact prompt path', () => {
        const prompt = agent.buildUserPromptForTest(
            makeInput({
                reviewDirective: DIRECTIVE,
                adaptiveProfile: resolveAdaptiveProfile(16_000),
            }),
        );
        expect(prompt).toContain('<ReviewFocus>');
        expect(prompt).toContain(DIRECTIVE);
    });

    it('renders the focus block on the self-contained path (CLI / no sandbox)', () => {
        // remoteCommands undefined → buildSelfContainedUserPrompt, the path the
        // CLI review uses. The directive must steer there too.
        const prompt = agent.buildUserPromptForTest(
            makeInput({ reviewDirective: DIRECTIVE, remoteCommands: undefined }),
        );
        expect(prompt).toContain('mode="self-contained"');
        expect(prompt).toContain('<ReviewFocus>');
        expect(prompt).toContain(DIRECTIVE);
    });

    it('renders no focus block on the self-contained path when no directive', () => {
        const prompt = agent.buildUserPromptForTest(
            makeInput({ remoteCommands: undefined }),
        );
        expect(prompt).toContain('mode="self-contained"');
        expect(prompt).not.toContain('<ReviewFocus>');
    });
});
