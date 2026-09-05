import { resolveAdaptiveProfile } from '@libs/code-review/infrastructure/agents/engine/adaptive-fit';
import { BaseCodeReviewAgentProvider } from '@libs/code-review/infrastructure/agents/providers/base-code-review-agent.provider';
import type {
    ReviewAgentIdentity,
    ReviewAgentInput,
} from '@libs/code-review/infrastructure/agents/review-agent.contract';
import {
    REVIEW_CONTEXT_CONTENT_TYPE,
    REVIEW_CONTEXT_SOURCE,
} from '@libs/cli-review/domain/types/review-context.types';

class TestAgent extends BaseCodeReviewAgentProvider {
    constructor() {
        super(null, null, undefined);
    }

    protected getIdentity(): ReviewAgentIdentity {
        return {
            name: 'test-review-agent',
            description: 'test reviewer',
            goal: 'find defects',
            expertise: ['testing'],
        };
    }

    protected getCategoryPrompt(): string {
        return 'category prompt';
    }

    protected getCategoryLabel(): string {
        return 'bug';
    }

    buildUserPromptForTest(input: ReviewAgentInput): string {
        return this.buildUserPrompt(input);
    }
}

const CONTEXT_BODY = 'CANARY α\nInvestigate abort cleanup exactly.';
const reviewContext = {
    source: REVIEW_CONTEXT_SOURCE,
    contentType: REVIEW_CONTEXT_CONTENT_TYPE,
    body: CONTEXT_BODY,
};

function makeInput(
    overrides: Partial<ReviewAgentInput> = {},
): ReviewAgentInput {
    return {
        organizationAndTeamData: { organizationId: 'org', teamId: 'team' },
        changedFiles: [
            {
                content: '',
                sha: 'sha',
                filename: 'src/file.ts',
                status: 'modified',
                additions: 1,
                deletions: 0,
                changes: 1,
                blob_url: '',
                raw_url: '',
                contents_url: '',
                patch: '+const x = 1;',
            },
        ],
        prNumber: 1,
        repositoryFullName: 'kodus/test',
        languageResultPrompt: 'en-US',
        remoteCommands: {
            grep: async () => '',
            read: async () => '',
            listDir: async () => '',
        },
        reviewContext,
        ...overrides,
    };
}

function expectStableReviewContextBlock(prompt: string): void {
    expect(prompt.match(/<ReviewContext\b/g)).toHaveLength(1);
    expect(prompt.match(/<\/ReviewContext>/g)).toHaveLength(1);
    expect(prompt.split(CONTEXT_BODY)).toHaveLength(2);
    expect(prompt).toContain(`source="${REVIEW_CONTEXT_SOURCE}"`);
    expect(prompt).toContain(`content-type="${REVIEW_CONTEXT_CONTENT_TYPE}"`);
    expect(prompt.indexOf('<ReviewContext')).toBeLessThan(
        prompt.indexOf('<Diffs'),
    );
}

describe('review context prompt rendering', () => {
    const agent = new TestAgent();

    it('places exact context in the full finding prompt', () => {
        expectStableReviewContextBlock(
            agent.buildUserPromptForTest(makeInput()),
        );
    });

    it('places exact context in the compact finding prompt', () => {
        expectStableReviewContextBlock(
            agent.buildUserPromptForTest(
                makeInput({
                    adaptiveProfile: resolveAdaptiveProfile(16_000),
                }),
            ),
        );
    });

    it('places exact context in the self-contained finding prompt', () => {
        expectStableReviewContextBlock(
            agent.buildUserPromptForTest(
                makeInput({ remoteCommands: undefined }),
            ),
        );
    });

    it('omits the entire block when context is absent', () => {
        const prompt = agent.buildUserPromptForTest(
            makeInput({ reviewContext: undefined }),
        );

        expect(prompt).not.toContain('<ReviewContext');
        expect(prompt).not.toContain(CONTEXT_BODY);
    });
});
