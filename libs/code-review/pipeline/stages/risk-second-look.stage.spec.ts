import { RiskSecondLookStage } from './risk-second-look.stage';
import { PrRiskAssessmentService } from '../services/pr-risk-assessment.service';
import {
    createRiskSecondLook,
    riskAgentRun,
} from '@libs/code-review/domain/risk/risk-second-look';
import type { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

jest.mock('@libs/code-review/domain/risk/risk-second-look', () => ({
    ...jest.requireActual('@libs/code-review/domain/risk/risk-second-look'),
    createRiskSecondLook: jest.fn(),
    riskAgentRun: jest.fn(),
}));

const medium = {
    status: 'assessed',
    riskIdentified: true,
    reason: 'Callers may rely on the old error.',
    snapshot: { assessmentKey: 'key', headSha: 'head', baseSha: 'base' },
};
const remoteCommands = {
    grep: jest.fn(),
    read: jest.fn(),
    listDir: jest.fn(),
};
const context = (
    overrides: Partial<CodeReviewPipelineContext> = {},
    config = {},
): CodeReviewPipelineContext =>
    ({
        organizationAndTeamData: { organizationId: 'org', teamId: 'team' },
        repository: { id: 'repo', name: 'repo', fullName: 'acme/repo' },
        pullRequest: { number: 4, title: 'Change', body: 'Why.' },
        codeReviewConfig: {
            riskAssessmentActive: true,
            pullRequestApprovalActive: true,
            languageResultPrompt: 'pt-BR',
            ...config,
        },
        origin: 'webhook',
        riskAssessment: medium,
        riskLevel: 'medium',
        fullPrFiles: [
            {
                filename: 'src/graph.ts',
                status: 'modified',
                additions: 1,
                deletions: 1,
                patch: '-return {};\n+throw error;',
            },
        ],
        sandboxHandle: { type: 'e2b', remoteCommands },
        ...overrides,
    }) as any;

const parameters = { findByKey: jest.fn() };
const permissions = { gateKodusCreditsForSlot: jest.fn() };
const service = new PrRiskAssessmentService(
    {} as any,
    {} as any,
    parameters as any,
    { isEnabled: jest.fn() },
    permissions as any,
);
const stage = new RiskSecondLookStage(service);
const look = jest.fn();

beforeEach(() => {
    jest.resetAllMocks();
    parameters.findByKey.mockResolvedValue(undefined);
    permissions.gateKodusCreditsForSlot.mockResolvedValue(false);
    jest.mocked(createRiskSecondLook).mockReturnValue(look);
    jest.mocked(riskAgentRun).mockReturnValue('run' as any);
});

it('stores what the look cleared, for this exact assessment', async () => {
    look.mockResolvedValue({
        reason: 'Both callers already catch it.',
        evidence: { file: 'src/caller.ts', line: 12 },
    });

    const result = await stage.execute(context());

    expect(result.riskSecondLook).toEqual({
        assessmentKey: 'key',
        reason: 'Both callers already catch it.',
        evidence: { file: 'src/caller.ts', line: 12 },
    });
    // Routing and risk-conditioned agents keep the first judgment.
    expect(result.riskAssessment).toEqual(medium);
    const asked = look.mock.calls[0][0];
    expect(asked).toMatchObject({
        reason: 'Callers may rely on the old error.',
        language: 'pt-BR',
        diff: expect.stringContaining('src/graph.ts (modified; +1/-1)'),
    });
    expect(asked.tools.map((t: { name: string }) => t.name)).toEqual(
        expect.arrayContaining(['grep', 'readFile', 'listDir']),
    );
    expect(asked.tools.map((t: { name: string }) => t.name)).not.toContain(
        'exec',
    );
});

it.each([
    ['approval is off', context({}, { pullRequestApprovalActive: false })],
    ['risk is off', context({}, { riskAssessmentActive: false })],
    ['the review has no sandbox', context({ sandboxHandle: undefined })],
    [
        'the sandbox is the null one',
        context({ sandboxHandle: { type: 'null', remoteCommands } as any }),
    ],
    ['it runs from the CLI', context({ origin: 'cli' } as any)],
    ['the rating is high', context({ riskLevel: 'high' })],
    [
        'there is no risk',
        context({
            riskAssessment: { ...medium, riskIdentified: false } as any,
            riskLevel: 'low',
        }),
    ],
    [
        'the assessment was reused without its level',
        context({ riskLevel: undefined }),
    ],
])('skips the look when %s', async (_, input) => {
    const result = await stage.execute(input);
    expect(look).not.toHaveBeenCalled();
    expect(result.riskSecondLook).toBeUndefined();
});

it('keeps the first judgment when credits are gated or the look fails', async () => {
    permissions.gateKodusCreditsForSlot.mockResolvedValueOnce(true);
    expect((await stage.execute(context())).riskSecondLook).toBeUndefined();
    expect(look).not.toHaveBeenCalled();

    look.mockRejectedValueOnce(new Error('timeout'));
    const failed = await stage.execute(context());
    expect(failed.riskSecondLook).toBeUndefined();
    expect(failed.errors ?? []).toEqual([]);
});
