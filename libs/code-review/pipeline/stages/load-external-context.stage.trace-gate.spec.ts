import { LoadExternalContextStage } from './load-external-context.stage';
import { FEATURE_KEYS } from '@libs/feature-gate';

describe('LoadExternalContextStage Trace alpha gate', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const context = {
        organizationAndTeamData,
        repository: { id: 'repo-1', name: 'repo' },
        pullRequest: { head: { ref: 'feature' }, number: 42 },
        changedFiles: [{ filename: 'src/index.ts' }],
    } as any;

    function makeStage(options?: { enabled?: boolean; gateError?: Error }) {
        const buildTraceContextPackUseCase = {
            execute: jest.fn().mockResolvedValue({
                decisions: [{ decision: 'Keep the timeout bounded.' }],
                droppedForBudget: 0,
                estimatedTokens: 10,
            }),
        };
        const featureGate = {
            isEnabled: options?.gateError
                ? jest.fn().mockRejectedValue(options.gateError)
                : jest.fn().mockResolvedValue(options?.enabled ?? false),
        };
        const organizationService = {
            getReleaseTrack: jest.fn().mockResolvedValue('alpha'),
        };

        const stage = new LoadExternalContextStage(
            {} as any,
            {} as any,
            {} as any,
            buildTraceContextPackUseCase as any,
            featureGate as any,
            organizationService as any,
        );

        return {
            stage,
            buildTraceContextPackUseCase,
            featureGate,
            organizationService,
        };
    }

    it('does not read Trace decisions when the alpha gate is disabled', async () => {
        const { stage, buildTraceContextPackUseCase, featureGate } =
            makeStage();

        const result = await (stage as any).loadTraceDecisions(context);

        expect(result).toBeUndefined();
        expect(buildTraceContextPackUseCase.execute).not.toHaveBeenCalled();
        expect(featureGate.isEnabled).toHaveBeenCalledWith(
            FEATURE_KEYS.kodusTraceReviewContext,
            expect.objectContaining({
                identifier: 'org-1',
                organizationAndTeamData,
                releaseTrack: 'alpha',
                groups: { team: 'team-1', repository: 'repo-1' },
            }),
        );
    });

    it('loads repository decisions when the alpha gate is enabled', async () => {
        const { stage, buildTraceContextPackUseCase } = makeStage({
            enabled: true,
        });

        const result = await (stage as any).loadTraceDecisions(context);

        expect(result).toEqual([{ decision: 'Keep the timeout bounded.' }]);
        expect(buildTraceContextPackUseCase.execute).toHaveBeenCalledWith({
            organizationAndTeamData,
            repository: { id: 'repo-1', name: 'repo' },
            changedFilePaths: ['src/index.ts'],
            branch: 'feature',
        });
    });

    it('fails closed when the alpha gate cannot be evaluated', async () => {
        const { stage, buildTraceContextPackUseCase } = makeStage({
            gateError: new Error('PostHog unavailable'),
        });

        await expect(
            (stage as any).loadTraceDecisions(context),
        ).resolves.toBeUndefined();
        expect(buildTraceContextPackUseCase.execute).not.toHaveBeenCalled();
    });
});
