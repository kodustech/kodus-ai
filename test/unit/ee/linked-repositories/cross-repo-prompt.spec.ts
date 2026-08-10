import {
    buildSystemPrompt,
    formatCrossRepoBoundarySection,
} from '@libs/code-review/infrastructure/agents/prompts/prompt-builder';
import type { ReviewAgentInput } from '@libs/code-review/infrastructure/agents/review-agent.contract';
import type { LinkedRepoAccess } from '@libs/ee/linked-repositories';

const meta = {
    identity: {
        name: 'BugAgent',
        description: 'finds bugs',
        goal: 'bugs',
        expertise: [] as string[],
    },
    categoryPrompt: 'Find bugs.',
    categoryLabel: 'bug',
    allowedLabels: ['bug'] as Array<'bug'>,
    supportsMixed: false,
};

function baseInput(
    over: Partial<ReviewAgentInput> = {},
): ReviewAgentInput {
    return {
        organizationAndTeamData: { organizationId: 'o', teamId: 't' },
        changedFiles: [],
        prNumber: 1,
        repositoryFullName: 'org/frontend',
        remoteCommands: {} as any,
        languageResultPrompt: 'en-US',
        ...over,
    };
}

const linkedAccess: LinkedRepoAccess = {
    list: () => [
        {
            repository: 'org/backend-api',
            preferredRef: 'main',
            status: 'pending',
            instructions: 'REST API this frontend consumes',
        },
    ],
    ensureCloned: async () => ({
        ok: false as const,
        error: 'unused',
    }),
    getMetadata: () => ({
        configured: 1,
        resolved: 1,
        cloned: 0,
        failed: 0,
        warnings: [],
        repositories: [],
    }),
};

describe('cross-repo prompt directive', () => {
    it('omits CrossRepoBoundary when no linked repos', () => {
        expect(formatCrossRepoBoundarySection(baseInput())).toBe('');
        const sys = buildSystemPrompt(baseInput(), meta);
        expect(sys).not.toContain('CrossRepoBoundary');
        expect(sys).not.toContain('CROSS-BOUNDARY');
    });

    it('injects pilot-validated boundary directive when links are configured', () => {
        const section = formatCrossRepoBoundarySection(
            baseInput({ linkedRepoAccess: linkedAccess }),
        );
        expect(section).toContain('CrossRepoBoundary');
        expect(section).toContain('org/backend-api');
        expect(section).toContain('REST API this frontend consumes');
        expect(section).toContain('CROSS-BOUNDARY defects');
        expect(section).toContain(
            'find who produces or consumes it and verify the shapes match',
        );
        expect(section).toContain('sibling adapters');
        expect(section).toContain('CONFIRMED counterpart evidence');
        expect(section).toContain(
            'relevantFile/relevantLinesStart/relevantLinesEnd MUST stay inside this PR',
        );

        const sys = buildSystemPrompt(
            baseInput({ linkedRepoAccess: linkedAccess }),
            meta,
        );
        expect(sys).toContain('CrossRepoBoundary');
        expect(sys).toContain('[cross-repo]');
    });
});
