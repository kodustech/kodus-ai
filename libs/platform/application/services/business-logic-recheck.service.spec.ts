import { BusinessLogicRecheckService } from './business-logic-recheck.service';

describe('BusinessLogicRecheckService', () => {
    it('gives a run back to the queue when its re-check fails, so the next tick retries it', async () => {
        const run = {
            id: 'run-1',
            organizationId: 'org-1',
            teamId: 'team-1',
            repositoryId: 'repo-1',
            repositoryName: 'notes',
            pullRequestNumber: 47,
        };
        const runs = {
            claimPendingRecheck: jest
                .fn()
                .mockResolvedValueOnce(run)
                .mockResolvedValue(undefined),
            latestForPullRequest: jest.fn(async () => run),
            update: jest.fn(async () => undefined),
        };
        const code = {
            getPullRequest: jest.fn(async () => {
                throw new Error('GitHub is down');
            }),
        };
        const service = new BusinessLogicRecheckService(
            runs as any,
            {} as any,
            {} as any,
            code as any,
        );

        await expect(service.recheckPending()).resolves.toBe(0);
        expect(runs.update).toHaveBeenCalledWith('run-1', {
            pendingRecheck: true,
        });
    });

    describe('a PR the tracker kept waiting', () => {
        const createdAt = new Date('2026-10-21T10:00:00Z');
        const firstSkip = new Date('2026-10-21T02:00:00Z');
        const run = {
            id: 'run-2',
            organizationId: 'org-1',
            teamId: 'team-1',
            repositoryId: 'repo-1',
            repositoryName: 'notes',
            pullRequestNumber: 47,
            platformType: 'github',
            createdAt,
            pendingSince: firstSkip,
        };
        const build = ({
            enabled = true,
            canRun = true,
        }: { enabled?: boolean; canRun?: boolean } = {}) => {
            const runs = {
                claimPendingRecheck: jest
                    .fn()
                    .mockResolvedValueOnce(run)
                    .mockResolvedValue(undefined),
                latestForPullRequest: jest.fn(async () => run),
                update: jest.fn(async () => undefined),
            };
            const validation = {
                validate: jest.fn(async () => ({
                    outcome: { kind: 'skipped', reason: 'tracker_unavailable' },
                    references: [],
                    attempts: [],
                    trackers: [],
                })),
                canRun: jest.fn(async () => canRun),
            };
            const publisher = {
                configFor: jest.fn(async () => ({
                    settings: {},
                    enabled,
                    byokModelId: 'model-dir',
                })),
                withRepository: jest.fn((r: unknown) => r),
                publish: jest.fn(async () => ({})),
            };
            const code = {
                getPullRequest: jest.fn(async () => ({
                    state: 'open',
                    title: 'feat(SAA-96)',
                    head: { ref: 'feat/saa-96', sha: 'abc1234' },
                })),
            };
            return {
                service: new BusinessLogicRecheckService(
                    runs as any,
                    validation as any,
                    publisher as any,
                    code as any,
                ),
                validation,
                publisher,
            };
        };

        it("runs with the PR's directory settings and model, and keeps counting from the first skip", async () => {
            const { service, validation, publisher } = build();

            await expect(service.recheckPending()).resolves.toBe(1);

            expect(publisher.configFor).toHaveBeenCalledWith(
                { organizationId: 'org-1', teamId: 'team-1' },
                'repo-1',
                {
                    number: 47,
                    repositoryName: 'notes',
                    platformType: 'github',
                },
            );
            expect(validation.validate).toHaveBeenCalledWith(
                expect.objectContaining({ byokModelId: 'model-dir' }),
            );
            expect(publisher.publish).toHaveBeenCalledWith(
                expect.objectContaining({
                    trigger: 'recheck',
                    pendingSince: firstSkip,
                }),
            );
        });

        it('does nothing once the team turned Business Logic off, or the organization can no longer run reviews', async () => {
            for (const blocked of [{ enabled: false }, { canRun: false }]) {
                const { service, validation, publisher } = build(blocked);
                await expect(service.recheckPending()).resolves.toBe(0);
                expect(validation.validate).not.toHaveBeenCalled();
                expect(publisher.publish).not.toHaveBeenCalled();
            }
        });
    });
});
