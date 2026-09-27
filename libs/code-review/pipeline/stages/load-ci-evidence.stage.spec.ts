import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { CheckEvidence } from '@libs/platform/domain/platformIntegrations/types/codeManagement/checkEvidence.type';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

import { ManagedTool } from '@libs/code-review/infrastructure/adapters/services/ci-evidence/recognize-ci-analyzers';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { LoadCiEvidenceStage } from './load-ci-evidence.stage';

const check = (
    name: string,
    overrides: Partial<CheckEvidence> = {},
): CheckEvidence => ({
    id: 'check-1',
    name,
    status: 'completed',
    conclusion: 'success',
    url: null,
    completedAt: '2026-01-01T00:00:00Z',
    platform: PlatformType.GITHUB,
    ...overrides,
});

const makeContext = (
    overrides: Partial<CodeReviewPipelineContext> = {},
): CodeReviewPipelineContext =>
    ({
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: {
            id: 'repo-1',
            name: 'widget-api',
            fullName: 'acme/widget-api',
        },
        pullRequest: {
            number: 42,
            head: { sha: 'a1b2c3d4', ref: 'feature' },
        },
        codeReviewConfig: { deterministicEvidence: { ciChecks: true } },
        ...overrides,
    }) as unknown as CodeReviewPipelineContext;

describe('LoadCiEvidenceStage', () => {
    const makeStage = (getCheckEvidence: jest.Mock, gateEnabled = true) => {
        const codeManagementService = {
            getCheckEvidence,
        } as unknown as CodeManagementService;
        return new LoadCiEvidenceStage(codeManagementService, {
            isEnabled: jest.fn().mockResolvedValue(gateEnabled),
        } as never);
    };

    const run = (stage: LoadCiEvidenceStage, context: CodeReviewPipelineContext) =>
        (
            stage as unknown as {
                executeStage: (
                    c: CodeReviewPipelineContext,
                ) => Promise<CodeReviewPipelineContext>;
            }
        ).executeStage(context);

    it('stores the evidence it read on the context', async () => {
        const evidence = [check('semgrep')];
        const stage = makeStage(jest.fn().mockResolvedValue(evidence));

        const result = await run(stage, makeContext());

        expect(result.ciEvidence).toEqual(evidence);
    });

    it('records which managed tools the CI already covers', async () => {
        const stage = makeStage(
            jest.fn().mockResolvedValue([check('gitleaks'), check('build')]),
        );

        const result = await run(stage, makeContext());

        expect(result.ciCoveredTools).toEqual([ManagedTool.SECRETS]);
    });

    it('records no coverage when CI runs nothing we recognize', async () => {
        const stage = makeStage(
            jest.fn().mockResolvedValue([check('build'), check('test')]),
        );

        const result = await run(stage, makeContext());

        expect(result.ciCoveredTools).toEqual([]);
    });

    it('asks for annotations and keys the read to the head commit and PR', async () => {
        const getCheckEvidence = jest.fn().mockResolvedValue([]);
        const stage = makeStage(getCheckEvidence);

        await run(stage, makeContext());

        expect(getCheckEvidence).toHaveBeenCalledWith(
            expect.objectContaining({
                repository: expect.objectContaining({
                    owner: 'acme',
                    name: 'widget-api',
                    id: 'repo-1',
                }),
                commitSha: 'a1b2c3d4',
                prNumber: 42,
                includeAnnotations: true,
            }),
        );
    });

    // GitLab projects can sit under nested groups, so only the final segment
    // is the repository name — splitting on the first slash would address the
    // wrong project.
    it('keeps nested group paths in the owner', async () => {
        const getCheckEvidence = jest.fn().mockResolvedValue([]);
        const stage = makeStage(getCheckEvidence);

        await run(
            stage,
            makeContext({
                repository: {
                    id: 'repo-2',
                    name: 'project',
                    fullName: 'group/subgroup/project',
                },
            } as Partial<CodeReviewPipelineContext>),
        );

        expect(getCheckEvidence).toHaveBeenCalledWith(
            expect.objectContaining({
                repository: expect.objectContaining({
                    owner: 'group/subgroup',
                    name: 'project',
                }),
            }),
        );
    });

    it('does nothing when the pull request has no head commit', async () => {
        const getCheckEvidence = jest.fn();
        const stage = makeStage(getCheckEvidence);

        const context = makeContext({
            pullRequest: { number: 42 },
        } as Partial<CodeReviewPipelineContext>);
        const result = await run(stage, context);

        expect(getCheckEvidence).not.toHaveBeenCalled();
        expect(result.ciEvidence).toBeUndefined();
    });

    it('still asks when the host has no owner/name form, as Azure does', async () => {
        // Azure Repos reports a bare repository name and its adapter addresses
        // the repo by id. Requiring an "owner/name" fullName here dropped its
        // CI evidence on every review, silently.
        const getCheckEvidence = jest.fn().mockResolvedValue([]);
        const stage = makeStage(getCheckEvidence);

        await run(
            stage,
            makeContext({
                repository: { id: 'repo-3', name: 'widget-api' },
            } as Partial<CodeReviewPipelineContext>),
        );

        expect(getCheckEvidence).toHaveBeenCalledWith(
            expect.objectContaining({
                repository: expect.objectContaining({
                    id: 'repo-3',
                    name: 'widget-api',
                }),
            }),
        );
    });

    it('does nothing when there is neither a name nor an id', async () => {
        const getCheckEvidence = jest.fn();
        const stage = makeStage(getCheckEvidence);

        const result = await run(
            stage,
            makeContext({
                repository: {},
            } as Partial<CodeReviewPipelineContext>),
        );

        expect(getCheckEvidence).not.toHaveBeenCalled();
        expect(result.ciEvidence).toBeUndefined();
    });

    it('leaves the context untouched when CI reported nothing', async () => {
        const stage = makeStage(jest.fn().mockResolvedValue([]));

        const result = await run(stage, makeContext());

        expect(result.ciEvidence).toBeUndefined();
        expect(result.ciCoveredTools).toBeUndefined();
    });

    // Evidence is enrichment: a failure here must not fail the review.
    it('swallows a read failure and continues', async () => {
        const stage = makeStage(
            jest.fn().mockRejectedValue(new Error('unavailable')),
        );

        const result = await run(stage, makeContext());

        expect(result.ciEvidence).toBeUndefined();
    });

    // Beta feature: an org outside the release track gets none of it.
    it('reads nothing when the beta gate is closed', async () => {
        const getCheckEvidence = jest.fn();
        const stage = makeStage(getCheckEvidence, false);

        const result = await run(stage, makeContext());

        expect(getCheckEvidence).not.toHaveBeenCalled();
        expect(result.ciEvidence).toBeUndefined();
    });

    describe('the ciChecks gate', () => {
        // Nothing consumes this evidence yet, so an always-on read would be
        // pure added latency on every review.
        it('reads nothing when the flag is absent', async () => {
            const getCheckEvidence = jest.fn();
            const stage = makeStage(getCheckEvidence);

            const result = await run(
                stage,
                makeContext({
                    codeReviewConfig: {},
                } as Partial<CodeReviewPipelineContext>),
            );

            expect(getCheckEvidence).not.toHaveBeenCalled();
            expect(result.ciEvidence).toBeUndefined();
        });

        it('reads nothing when the flag is off', async () => {
            const getCheckEvidence = jest.fn();
            const stage = makeStage(getCheckEvidence);

            await run(
                stage,
                makeContext({
                    codeReviewConfig: {
                        deterministicEvidence: { ciChecks: false },
                    },
                } as Partial<CodeReviewPipelineContext>),
            );

            expect(getCheckEvidence).not.toHaveBeenCalled();
        });

        it('reads when the flag is on', async () => {
            const getCheckEvidence = jest.fn().mockResolvedValue([]);
            const stage = makeStage(getCheckEvidence);

            await run(stage, makeContext());

            expect(getCheckEvidence).toHaveBeenCalled();
        });
    });
});
