// See github.service.cache.spec.ts for why environment.ts is mocked here.
jest.mock(
    '../../../../../ee/configs/environment/environment',
    () => ({ environment: {} }),
    { virtual: true },
);

import { ConfigService } from '@nestjs/config';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { GithubService } from './github.service';

describe('GithubService — getCheckEvidence', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };
    const repository = { owner: 'acme', name: 'widget-api' };
    const commitSha = 'a1b2c3d4';

    const makeService = (octokitOverrides: {
        listForRef?: jest.Mock;
        listCommitStatusesForRef?: jest.Mock;
        listAnnotations?: jest.Mock;
    }) => {
        const service = new GithubService(
            { findOne: jest.fn() } as never,
            {} as never,
            { createOrUpdateConfig: jest.fn() } as never,
            {
                getFromCache: jest.fn().mockResolvedValue(null),
                addToCache: jest.fn().mockResolvedValue(undefined),
            } as never,
            { get: jest.fn() } as unknown as ConfigService,
        );

        const octokit = {
            rest: {
                checks: {
                    listForRef:
                        octokitOverrides.listForRef ??
                        jest
                            .fn()
                            .mockResolvedValue({ data: { check_runs: [] } }),
                    listAnnotations:
                        octokitOverrides.listAnnotations ??
                        jest.fn().mockResolvedValue({ data: [] }),
                },
                repos: {
                    listCommitStatusesForRef:
                        octokitOverrides.listCommitStatusesForRef ??
                        jest.fn().mockResolvedValue({ data: [] }),
                },
            },
        };

        jest.spyOn(
            service as unknown as {
                getAuthenticatedOctokit: () => Promise<unknown>;
            },
            'getAuthenticatedOctokit',
        ).mockResolvedValue(octokit);

        return { service, octokit };
    };

    const checkRun = (overrides: Record<string, unknown> = {}) => ({
        id: 991,
        name: 'semgrep',
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://example.test/runs/991',
        completed_at: '2026-01-01T00:00:00Z',
        app: { slug: 'semgrep-app' },
        ...overrides,
    });

    it('normalizes a completed check run', async () => {
        const { service } = makeService({
            listForRef: jest
                .fn()
                .mockResolvedValue({ data: { check_runs: [checkRun()] } }),
        });

        const evidence = await service.getCheckEvidence({
            organizationAndTeamData,
            repository,
            commitSha,
        });

        expect(evidence).toEqual([
            {
                id: '991',
                name: 'semgrep',
                status: 'completed',
                conclusion: 'success',
                url: 'https://example.test/runs/991',
                reporter: 'semgrep-app',
                completedAt: '2026-01-01T00:00:00Z',
                platform: PlatformType.GITHUB,
            },
        ]);
    });

    it('queries the head commit', async () => {
        const listForRef = jest
            .fn()
            .mockResolvedValue({ data: { check_runs: [] } });
        const { service } = makeService({ listForRef });

        await service.getCheckEvidence({
            organizationAndTeamData,
            repository,
            commitSha,
        });

        expect(listForRef).toHaveBeenCalledWith(
            expect.objectContaining({
                owner: 'acme',
                repo: 'widget-api',
                ref: commitSha,
            }),
        );
    });

    it('reports an in-flight run with no conclusion', async () => {
        const { service } = makeService({
            listForRef: jest.fn().mockResolvedValue({
                data: {
                    check_runs: [
                        checkRun({
                            status: 'in_progress',
                            conclusion: null,
                            completed_at: null,
                        }),
                    ],
                },
            }),
        });

        const [evidence] = await service.getCheckEvidence({
            organizationAndTeamData,
            repository,
            commitSha,
        });

        expect(evidence.status).toBe('in_progress');
        expect(evidence.conclusion).toBeNull();
        expect(evidence.completedAt).toBeNull();
    });

    it('also returns legacy commit statuses, which older integrations still use', async () => {
        const { service } = makeService({
            listCommitStatusesForRef: jest.fn().mockResolvedValue({
                data: [
                    {
                        id: 77,
                        context: 'sonarcloud',
                        state: 'failure',
                        target_url: 'https://example.test/status/77',
                        updated_at: '2026-01-02T00:00:00Z',
                    },
                ],
            }),
        });

        const evidence = await service.getCheckEvidence({
            organizationAndTeamData,
            repository,
            commitSha,
        });

        expect(evidence).toEqual([
            {
                id: '77',
                name: 'sonarcloud',
                status: 'completed',
                conclusion: 'failure',
                url: 'https://example.test/status/77',
                completedAt: '2026-01-02T00:00:00Z',
                platform: PlatformType.GITHUB,
            },
        ]);
    });

    it('maps a pending commit status to an unfinished run', async () => {
        const { service } = makeService({
            listCommitStatusesForRef: jest.fn().mockResolvedValue({
                data: [
                    {
                        id: 78,
                        context: 'build',
                        state: 'pending',
                        target_url: null,
                        updated_at: '2026-01-02T00:00:00Z',
                    },
                ],
            }),
        });

        const [evidence] = await service.getCheckEvidence({
            organizationAndTeamData,
            repository,
            commitSha,
        });

        expect(evidence.status).toBe('in_progress');
        expect(evidence.conclusion).toBeNull();
    });

    // The two endpoints are independent; losing one must not lose the other.
    it('keeps check runs when the commit-status call fails', async () => {
        const { service } = makeService({
            listForRef: jest
                .fn()
                .mockResolvedValue({ data: { check_runs: [checkRun()] } }),
            listCommitStatusesForRef: jest
                .fn()
                .mockRejectedValue(new Error('rate limited')),
        });

        const evidence = await service.getCheckEvidence({
            organizationAndTeamData,
            repository,
            commitSha,
        });

        expect(evidence).toHaveLength(1);
        expect(evidence[0].name).toBe('semgrep');
    });

    describe('annotations', () => {
        const annotated = (count: number) =>
            checkRun({ output: { annotations_count: count } });

        const annotation = (overrides: Record<string, unknown> = {}) => ({
            path: 'src/api/handler.ts',
            start_line: 12,
            end_line: 14,
            annotation_level: 'failure',
            message: 'Detected a hardcoded credential.',
            title: 'generic.secrets.hardcoded',
            ...overrides,
        });

        it('does not fetch annotations unless asked', async () => {
            const listAnnotations = jest.fn();
            const { service } = makeService({
                listForRef: jest.fn().mockResolvedValue({
                    data: { check_runs: [annotated(3)] },
                }),
                listAnnotations,
            });

            const [evidence] = await service.getCheckEvidence({
                organizationAndTeamData,
                repository,
                commitSha,
            });

            expect(listAnnotations).not.toHaveBeenCalled();
            // Undefined, not [] — "not fetched" must not read as "none found".
            expect(evidence.annotations).toBeUndefined();
        });

        it('attaches normalized annotations when asked', async () => {
            const { service } = makeService({
                listForRef: jest.fn().mockResolvedValue({
                    data: { check_runs: [annotated(1)] },
                }),
                listAnnotations: jest
                    .fn()
                    .mockResolvedValue({ data: [annotation()] }),
            });

            const [evidence] = await service.getCheckEvidence({
                organizationAndTeamData,
                repository,
                commitSha,
                includeAnnotations: true,
            });

            expect(evidence.annotations).toEqual([
                {
                    path: 'src/api/handler.ts',
                    startLine: 12,
                    endLine: 14,
                    level: 'failure',
                    message: 'Detected a hardcoded credential.',
                    title: 'generic.secrets.hardcoded',
                },
            ]);
        });

        // The check run carries its own annotation count, so a run with none
        // costs zero extra round trips.
        it('skips the extra call for a run reporting no annotations', async () => {
            const listAnnotations = jest.fn();
            const { service } = makeService({
                listForRef: jest.fn().mockResolvedValue({
                    data: { check_runs: [annotated(0)] },
                }),
                listAnnotations,
            });

            const [evidence] = await service.getCheckEvidence({
                organizationAndTeamData,
                repository,
                commitSha,
                includeAnnotations: true,
            });

            expect(listAnnotations).not.toHaveBeenCalled();
            expect(evidence.annotations).toEqual([]);
        });

        it('requests annotations for the owning check run', async () => {
            const listAnnotations = jest.fn().mockResolvedValue({ data: [] });
            const { service } = makeService({
                listForRef: jest.fn().mockResolvedValue({
                    data: { check_runs: [annotated(2)] },
                }),
                listAnnotations,
            });

            await service.getCheckEvidence({
                organizationAndTeamData,
                repository,
                commitSha,
                includeAnnotations: true,
            });

            expect(listAnnotations).toHaveBeenCalledWith(
                expect.objectContaining({
                    owner: 'acme',
                    repo: 'widget-api',
                    check_run_id: 991,
                }),
            );
        });

        // A noisy linter can post hundreds; the review only ever needs a
        // bounded sample, and the rest would just burn prompt budget.
        it('caps annotations per run', async () => {
            const many = Array.from({ length: 120 }, (_, i) =>
                annotation({ start_line: i + 1, end_line: i + 1 }),
            );
            const { service } = makeService({
                listForRef: jest.fn().mockResolvedValue({
                    data: { check_runs: [annotated(120)] },
                }),
                listAnnotations: jest.fn().mockResolvedValue({ data: many }),
            });

            const [evidence] = await service.getCheckEvidence({
                organizationAndTeamData,
                repository,
                commitSha,
                includeAnnotations: true,
            });

            expect(evidence.annotations.length).toBeLessThanOrEqual(50);
        });

        it('keeps the check run when its annotation fetch fails', async () => {
            const { service } = makeService({
                listForRef: jest.fn().mockResolvedValue({
                    data: { check_runs: [annotated(3)] },
                }),
                listAnnotations: jest
                    .fn()
                    .mockRejectedValue(new Error('rate limited')),
            });

            const [evidence] = await service.getCheckEvidence({
                organizationAndTeamData,
                repository,
                commitSha,
                includeAnnotations: true,
            });

            expect(evidence.name).toBe('semgrep');
            expect(evidence.annotations).toBeUndefined();
        });

        it('defaults an unrecognized annotation level to warning', async () => {
            const { service } = makeService({
                listForRef: jest.fn().mockResolvedValue({
                    data: { check_runs: [annotated(1)] },
                }),
                listAnnotations: jest.fn().mockResolvedValue({
                    data: [annotation({ annotation_level: 'something-new' })],
                }),
            });

            const [evidence] = await service.getCheckEvidence({
                organizationAndTeamData,
                repository,
                commitSha,
                includeAnnotations: true,
            });

            expect(evidence.annotations[0].level).toBe('warning');
        });

        it('falls back to the start line when no end line is given', async () => {
            const { service } = makeService({
                listForRef: jest.fn().mockResolvedValue({
                    data: { check_runs: [annotated(1)] },
                }),
                listAnnotations: jest.fn().mockResolvedValue({
                    data: [annotation({ end_line: null })],
                }),
            });

            const [evidence] = await service.getCheckEvidence({
                organizationAndTeamData,
                repository,
                commitSha,
                includeAnnotations: true,
            });

            expect(evidence.annotations[0].endLine).toBe(12);
        });
    });

    it('declares annotation support', async () => {
        const { service } = makeService({});

        expect(
            await service.supportsCheckEvidence(organizationAndTeamData),
        ).toEqual({ statuses: true, annotations: true });
    });

    it('returns [] when both calls fail', async () => {
        const { service } = makeService({
            listForRef: jest.fn().mockRejectedValue(new Error('boom')),
            listCommitStatusesForRef: jest
                .fn()
                .mockRejectedValue(new Error('boom')),
        });

        expect(
            await service.getCheckEvidence({
                organizationAndTeamData,
                repository,
                commitSha,
            }),
        ).toEqual([]);
    });
});
