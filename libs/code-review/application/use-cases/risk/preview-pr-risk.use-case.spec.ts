import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ParametersKey } from '@libs/core/domain/enums';
import { PreviewPrRiskUseCase } from './preview-pr-risk.use-case';

const parameters = { findByKey: jest.fn() };
const host = { getPullRequestByNumber: jest.fn() };
const risk = { assess: jest.fn() };
const useCase = new PreviewPrRiskUseCase(
    parameters as any,
    host as any,
    risk as any,
);
const input = {
    organizationAndTeamData: { organizationId: 'org', teamId: 'team' },
    repositoryId: 'repo',
    prNumber: 8,
};

beforeEach(() => {
    jest.resetAllMocks();
    parameters.findByKey.mockImplementation(async (key) => ({
        configValue:
            key === ParametersKey.CODE_REVIEW_CONFIG
                ? {
                      repositories: [
                          { id: 'repo', name: 'acme/api', isSelected: true },
                      ],
                  }
                : 'en-US',
    }));
    host.getPullRequestByNumber.mockResolvedValue({
        number: 8,
        title: 'Change',
        base: { sha: 'base' },
        head: { sha: 'head' },
    });
    risk.assess.mockResolvedValue({
        assessment: { status: 'unavailable', reason: 'Insufficient evidence.' },
        fullPrFiles: [],
    });
});

it('previews draft criteria on the real shared assessment service without approval configuration', async () => {
    const criteria = [
        {
            id: 'access',
            name: 'Access',
            enabled: true,
            instructions: 'Check tenant isolation.',
        },
    ];
    await useCase.execute({ ...input, criteria });
    expect(risk.assess).toHaveBeenCalledWith(
        expect.objectContaining({
            repository: { id: 'repo', name: 'acme/api' },
            origin: 'preview',
            codeReviewConfig: {
                riskAssessmentActive: true,
                riskCriteria: criteria,
                languageResultPrompt: 'en-US',
            },
        }),
    );
    expect(host.getPullRequestByNumber).toHaveBeenCalledWith(
        expect.objectContaining({
            organizationAndTeamData: input.organizationAndTeamData,
            prNumber: 8,
        }),
    );
});

it('rejects a repository outside the caller team before reading its PR', async () => {
    await expect(
        useCase.execute({ ...input, repositoryId: 'another-team-repo' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(host.getPullRequestByNumber).not.toHaveBeenCalled();
    expect(risk.assess).not.toHaveBeenCalled();
});

it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid PR number %s before spending calls',
    async (prNumber) => {
        await expect(
            useCase.execute({ ...input, prNumber }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(risk.assess).not.toHaveBeenCalled();
    },
);

it('rejects malformed draft guidance instead of running without it', async () => {
    await expect(
        useCase.execute({ ...input, criteria: [{ instructions: 42 }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(risk.assess).not.toHaveBeenCalled();
});

it('preserves unavailable results and returns file metadata without source contents', async () => {
    risk.assess.mockResolvedValue({
        assessment: { status: 'unavailable', reason: 'Timeout.' },
        fullPrFiles: [
            {
                filename: 'docs/auth.ts',
                previous_filename: 'src/auth.ts',
                status: 'renamed',
                patch: 'private source code',
            },
        ],
    });
    const result = await useCase.execute(input);
    expect(result).toEqual({
        assessment: { status: 'unavailable', reason: 'Timeout.' },
        files: [
            {
                path: 'docs/auth.ts',
                previousPath: 'src/auth.ts',
                status: 'renamed',
            },
        ],
    });
    expect(JSON.stringify(result)).not.toContain('private source code');
});
