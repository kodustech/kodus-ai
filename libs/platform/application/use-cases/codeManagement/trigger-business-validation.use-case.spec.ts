import { BadRequestException } from '@nestjs/common';

import { TriggerBusinessValidationUseCase } from './trigger-business-validation.use-case';

/**
 * Mutation-killing unit tests for the deterministic logic in
 * TriggerBusinessValidationUseCase. All target methods are pure and do not
 * touch the injected dependencies, so the class is built with inert stubs and
 * private methods are reached through an `any` cast.
 */
describe('TriggerBusinessValidationUseCase (deterministic logic)', () => {
    let useCase: TriggerBusinessValidationUseCase;
    // Typed escape hatch to reach private methods.
    let target: any;

    beforeEach(() => {
        useCase = new TriggerBusinessValidationUseCase(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );
        target = useCase as any;
    });

    describe('resolveMode', () => {
        it('throws when both prUrl and prNumber are provided', () => {
            expect(() =>
                target.resolveMode({ prUrl: 'http://a', prNumber: 1 }),
            ).toThrow('Use either prUrl or prNumber (not both).');
        });

        it('throws when prNumber is given without repositoryId or repository', () => {
            expect(() => target.resolveMode({ prNumber: 5 })).toThrow(
                'repositoryId or repository is required when prNumber is provided.',
            );
        });

        it('does not require repository when prNumber has repositoryId', () => {
            expect(
                target.resolveMode({ prNumber: 5, repositoryId: 'r1' }),
            ).toBe('pull_request');
        });

        it('does not require repository when prNumber has repository name', () => {
            expect(
                target.resolveMode({ prNumber: 5, repository: 'my-repo' }),
            ).toBe('pull_request');
        });

        it('treats whitespace-only repositoryId/repository as missing for prNumber', () => {
            expect(() =>
                target.resolveMode({
                    prNumber: 5,
                    repositoryId: '   ',
                    repository: '  ',
                }),
            ).toThrow(
                'repositoryId or repository is required when prNumber is provided.',
            );
        });

        it('throws when both taskUrl and taskId are provided', () => {
            expect(() =>
                target.resolveMode({
                    prUrl: 'http://a',
                    taskUrl: 'http://t',
                    taskId: 'T-1',
                }),
            ).toThrow('Provide either taskUrl or taskId (not both).');
        });

        it('throws when pull request context and diff are both provided (prUrl)', () => {
            expect(() =>
                target.resolveMode({ prUrl: 'http://a', diff: 'some diff' }),
            ).toThrow(
                'Use either pull request context (prUrl/prNumber) or diff (not both).',
            );
        });

        it('throws when pull request context and diff are both provided (prNumber)', () => {
            expect(() =>
                target.resolveMode({
                    prNumber: 5,
                    repositoryId: 'r1',
                    diff: 'some diff',
                }),
            ).toThrow(
                'Use either pull request context (prUrl/prNumber) or diff (not both).',
            );
        });

        it('returns pull_request when only prUrl is set', () => {
            expect(target.resolveMode({ prUrl: 'http://a' })).toBe(
                'pull_request',
            );
        });

        it('returns local_diff when only diff is set', () => {
            expect(target.resolveMode({ diff: 'my diff' })).toBe('local_diff');
        });

        it('ignores whitespace-only prUrl and diff (falls through to throw)', () => {
            expect(() =>
                target.resolveMode({ prUrl: '   ', diff: '   ' }),
            ).toThrow(
                'Provide either pull request context (prUrl/prNumber) or diff.',
            );
        });

        it('throws when nothing is provided', () => {
            expect(() => target.resolveMode({})).toThrow(
                'Provide either pull request context (prUrl/prNumber) or diff.',
            );
        });

        it('treats prNumber 0 as a provided number (typeof check, not truthiness)', () => {
            // prNumber === 0 is a number, so hasPrNumber is true; without a
            // repository this must throw the repository-required error, proving
            // the guard uses `typeof === 'number'` rather than truthiness.
            expect(() => target.resolveMode({ prNumber: 0 })).toThrow(
                'repositoryId or repository is required when prNumber is provided.',
            );
        });

        it('throws BadRequestException instances', () => {
            expect(() => target.resolveMode({})).toThrow(BadRequestException);
        });
    });

    describe('buildBusinessValidationCommand', () => {
        it('appends the task reference when present', () => {
            expect(target.buildBusinessValidationCommand('PROJ-1')).toBe(
                '@kody -v business-logic PROJ-1',
            );
        });

        it('returns the bare command when reference is undefined', () => {
            expect(target.buildBusinessValidationCommand(undefined)).toBe(
                '@kody -v business-logic',
            );
        });

        it('returns the bare command when reference is an empty string', () => {
            expect(target.buildBusinessValidationCommand('')).toBe(
                '@kody -v business-logic',
            );
        });
    });

    describe('normalizeUrl', () => {
        it('trims, lowercases and strips trailing slashes', () => {
            expect(target.normalizeUrl('  HTTPS://Example.COM/PR/1//  ')).toBe(
                'https://example.com/pr/1',
            );
        });

        it('returns empty string for undefined', () => {
            expect(target.normalizeUrl(undefined)).toBe('');
        });

        it('returns empty string for whitespace-only input', () => {
            expect(target.normalizeUrl('   ')).toBe('');
        });

        it('leaves a url without trailing slash unchanged (aside from case)', () => {
            expect(target.normalizeUrl('http://a.com/x')).toBe(
                'http://a.com/x',
            );
        });
    });

    describe('normalizeDiff', () => {
        it('returns empty string when diff is not a string', () => {
            expect(target.normalizeDiff(undefined)).toBe('');
            expect(target.normalizeDiff(123 as any)).toBe('');
            expect(target.normalizeDiff(null as any)).toBe('');
        });

        it('returns empty string for whitespace-only diff', () => {
            expect(target.normalizeDiff('   \n\t ')).toBe('');
        });

        it('returns empty string for empty diff', () => {
            expect(target.normalizeDiff('')).toBe('');
        });

        it('returns the ORIGINAL (untrimmed) diff when it has content', () => {
            // The method returns the raw input, not the trimmed version, when
            // trimmed length > 0. Padding must be preserved.
            expect(target.normalizeDiff('  real diff  ')).toBe('  real diff  ');
        });
    });

    describe('extractRepositoryOwnerFromFullName', () => {
        it('returns the owner segment for a valid owner/name', () => {
            expect(
                target.extractRepositoryOwnerFromFullName('kodustech/kodus-ai'),
            ).toBe('kodustech');
        });

        it('returns undefined for a single-segment name', () => {
            expect(
                target.extractRepositoryOwnerFromFullName('kodus-ai'),
            ).toBeUndefined();
        });

        it('returns undefined for undefined / non-string input', () => {
            expect(
                target.extractRepositoryOwnerFromFullName(undefined),
            ).toBeUndefined();
            expect(
                target.extractRepositoryOwnerFromFullName(42 as any),
            ).toBeUndefined();
        });

        it('returns undefined for whitespace-only input', () => {
            expect(
                target.extractRepositoryOwnerFromFullName('   '),
            ).toBeUndefined();
        });

        it('uses the LAST segment as the tail for multi-segment names', () => {
            expect(
                target.extractRepositoryOwnerFromFullName('a/b/c', 'c'),
            ).toBe('a');
        });

        it('returns the owner when the tail matches the repository name (case-insensitive)', () => {
            expect(
                target.extractRepositoryOwnerFromFullName(
                    'Kodustech/Kodus-AI',
                    'kodus-ai',
                ),
            ).toBe('Kodustech');
        });

        it('returns undefined when the tail does not match the repository name', () => {
            expect(
                target.extractRepositoryOwnerFromFullName(
                    'kodustech/kodus-ai',
                    'other-repo',
                ),
            ).toBeUndefined();
        });

        it('compares against the last segment of a slashed repository name', () => {
            expect(
                target.extractRepositoryOwnerFromFullName(
                    'kodustech/kodus-ai',
                    'group/kodus-ai',
                ),
            ).toBe('kodustech');
        });

        it('ignores an empty repository name (no tail comparison)', () => {
            expect(
                target.extractRepositoryOwnerFromFullName(
                    'kodustech/kodus-ai',
                    '   ',
                ),
            ).toBe('kodustech');
        });
    });

    describe('findBestPrByUrl', () => {
        it('returns undefined for an empty list', () => {
            expect(target.findBestPrByUrl([], 'http://a')).toBeUndefined();
        });

        it('returns undefined when the list argument is undefined (default param)', () => {
            expect(
                target.findBestPrByUrl(undefined, 'http://a'),
            ).toBeUndefined();
        });

        it('returns the PR whose normalized url matches the requested url', () => {
            const prs = [
                { prURL: 'http://a.com/1' },
                { prURL: 'http://b.com/2' },
            ] as any;
            expect(target.findBestPrByUrl(prs, 'HTTP://B.com/2/')).toBe(prs[1]);
        });

        it('matches by the number in the link when the urls differ', () => {
            const prs = [
                { number: 1, prURL: 'http://a.com/1' },
                {
                    number: 12,
                    prURL: 'http://api.gl/projects/3/mr/12',
                    repositoryData: { name: 'acme/notes' },
                },
            ] as any;
            expect(
                target.findBestPrByUrl(
                    prs,
                    'https://gl.com/acme/notes/-/merge_requests/12/diffs',
                ),
            ).toBe(prs[1]);
        });

        it('never takes the same number from another repository', () => {
            const prs = [
                {
                    number: 47,
                    prURL: 'http://api.gh/repos/acme/notes/pulls/47',
                    repositoryData: { name: 'notes' },
                    base: { repo: { fullName: 'acme/notes' } },
                },
                {
                    number: 47,
                    prURL: 'http://api.gh/repos/acme/web/pulls/47',
                    repositoryData: { name: 'web' },
                },
            ] as any;
            expect(
                target.findBestPrByUrl(
                    prs,
                    'https://github.com/acme/other/pull/47',
                ),
            ).toBeUndefined();
            expect(
                target.findBestPrByUrl(
                    prs,
                    'https://github.com/acme/web/pull/47',
                ),
            ).toBe(prs[1]);
        });

        it('takes a PR that names no repository only when it is the only one', () => {
            const only = [{ number: 5, prURL: 'http://x/5' }] as any;
            const two = [...only, { number: 6, prURL: 'http://x/6' }] as any;
            const url = 'https://dev.azure.com/o/p/_git/r/pullrequest/5';
            expect(target.findBestPrByUrl(only, url)).toBe(only[0]);
            expect(target.findBestPrByUrl(two, url)).toBeUndefined();
        });

        it('never picks another PR when nothing matches', () => {
            const prs = [
                { number: 1, prURL: 'http://a.com/1' },
                { number: 2, prURL: 'http://b.com/2' },
            ] as any;
            expect(
                target.findBestPrByUrl(prs, 'https://gh.com/a/b/pull/47'),
            ).toBeUndefined();
        });
    });

    describe('mapPullRequestContext', () => {
        it('maps a fully-populated pull request into the execution context', () => {
            const pr = {
                number: 42,
                prURL: 'http://gh/pr/42',
                repositoryData: { id: 'repo-1', name: 'kodus-ai' },
                head: {
                    ref: 'feature',
                    repo: {
                        fullName: 'kodustech/kodus-ai',
                        name: 'kodus-ai',
                        defaultBranch: 'develop',
                    },
                },
                base: {
                    ref: 'main',
                    repo: {
                        fullName: 'kodustech/kodus-ai',
                        name: 'kodus-ai',
                        defaultBranch: 'main',
                    },
                },
                body: 'PR body',
            } as any;

            expect(target.mapPullRequestContext(pr, 'http://fallback')).toEqual(
                {
                    mode: 'pull_request',
                    prNumber: 42,
                    prUrl: 'http://gh/pr/42',
                    repository: {
                        id: 'repo-1',
                        name: 'kodus-ai',
                        owner: 'kodustech',
                        defaultBranch: 'main',
                    },
                    pullRequestDescription: 'PR body',
                    headRef: 'feature',
                    baseRef: 'main',
                },
            );
        });

        it('derives prNumber from pull_number when number is absent', () => {
            const pr = {
                pull_number: 7,
                prURL: 'http://gh/pr/7',
                repositoryData: { id: 'r', name: 'n' },
            } as any;
            expect(target.mapPullRequestContext(pr, '').prNumber).toBe(7);
        });

        it('falls back to the provided url when prURL is missing', () => {
            const pr = {
                number: 1,
                repositoryData: { id: 'r', name: 'n' },
            } as any;
            expect(
                target.mapPullRequestContext(pr, 'http://fallback').prUrl,
            ).toBe('http://fallback');
        });

        it('uses pr.message as description when body is missing, and empty string when both absent', () => {
            const withMessage = {
                number: 1,
                repositoryData: { id: 'r', name: 'n' },
                message: 'from message',
            } as any;
            expect(
                target.mapPullRequestContext(withMessage, '')
                    .pullRequestDescription,
            ).toBe('from message');

            const withNeither = {
                number: 1,
                repositoryData: { id: 'r', name: 'n' },
            } as any;
            expect(
                target.mapPullRequestContext(withNeither, '')
                    .pullRequestDescription,
            ).toBe('');
        });

        it('falls back to fallbackRepository for id, name and owner', () => {
            const pr = { number: 1, prURL: '' } as any;
            const result = target.mapPullRequestContext(pr, 'http://f', {
                id: 'fid',
                name: 'fname',
                owner: 'fowner',
            });
            expect(result.repository.id).toBe('fid');
            expect(result.repository.name).toBe('fname');
            expect(result.repository.owner).toBe('fowner');
            expect(result.prUrl).toBe('http://f');
        });

        it('prefers pr.repositoryData for the id, the configured repository for the name', () => {
            const pr = {
                number: 1,
                prURL: 'u',
                repositoryData: { id: 'data-id', name: 'data-name' },
                repositoryId: 'plain-id',
            } as any;
            const result = target.mapPullRequestContext(pr, '', {
                id: 'fid',
                name: 'fname',
            });
            expect(result.repository.id).toBe('data-id');
            expect(result.repository.name).toBe('fname');
        });

        it('uses pr.repositoryId when repositoryData is absent', () => {
            const pr = {
                number: 1,
                prURL: 'u',
                repositoryId: 'plain-id',
                repository: 'plain-name',
            } as any;
            const result = target.mapPullRequestContext(pr, '');
            expect(result.repository.id).toBe('plain-id');
            expect(result.repository.name).toBe('plain-name');
        });

        it('prefers head repo owner over base repo owner', () => {
            const pr = {
                number: 1,
                prURL: 'u',
                repositoryData: { id: 'r', name: 'repo' },
                head: { repo: { fullName: 'headowner/repo', name: 'repo' } },
                base: { repo: { fullName: 'baseowner/repo', name: 'repo' } },
            } as any;
            expect(target.mapPullRequestContext(pr, '').repository.owner).toBe(
                'headowner',
            );
        });

        it('falls back to base.ref for defaultBranch when base.repo.defaultBranch is absent', () => {
            const pr = {
                number: 1,
                prURL: 'u',
                repositoryData: { id: 'r', name: 'repo' },
                base: { ref: 'release-branch', repo: { fullName: 'o/repo' } },
            } as any;
            expect(
                target.mapPullRequestContext(pr, '').repository.defaultBranch,
            ).toBe('release-branch');
        });

        it('throws when repository id cannot be resolved', () => {
            const pr = { number: 1, prURL: 'u' } as any;
            expect(() => target.mapPullRequestContext(pr, 'u')).toThrow(
                'Repository data not found for the selected pull request.',
            );
        });

        it('throws when repository name cannot be resolved', () => {
            const pr = {
                number: 1,
                prURL: 'u',
                repositoryData: { id: 'only-id' },
            } as any;
            expect(() => target.mapPullRequestContext(pr, 'u')).toThrow(
                'Repository data not found for the selected pull request.',
            );
        });
    });

    describe('execute (local diff)', () => {
        it('returns the verdict as text and JSON, records the run and writes nothing to a PR (UC-41)', async () => {
            const outcome = {
                kind: 'validated',
                checks: [
                    {
                        task: {
                            tracker: 'Azure DevOps',
                            id: 'AB#8',
                            title: 'Compact density toggle',
                        },
                        verdict: {
                            needsMoreInfo: false,
                            summary: 'x',
                            requirements: [
                                {
                                    requirement: 'Defaults to comfortable',
                                    source: 'AC #2',
                                    state: 'missing',
                                    evidence: [
                                        {
                                            file: 'src/settings/density.ts',
                                            line: 6,
                                        },
                                    ],
                                    note: 'Sets "compact".',
                                    action: 'Change it to "comfortable".',
                                    confidence: 'high',
                                },
                            ],
                            outOfScope: [],
                        },
                        passed: false,
                        readAt: '2026-10-05T00:00:00.000Z',
                    },
                ],
                thinTasks: [],
                passed: false,
                unseenFiles: [],
            };
            const service = {
                validate: jest.fn().mockResolvedValue({
                    outcome,
                    references: [],
                    attempts: [],
                    trackers: ['Azure DevOps'],
                }),
            };
            const publisher = {
                configFor: jest.fn().mockResolvedValue({
                    settings: {},
                    enabled: true,
                }),
                withRepository: jest.fn((r: unknown) => r),
                publish: jest.fn(),
            };
            const runs = { create: jest.fn().mockResolvedValue('run-1') };
            const cli = new TriggerBusinessValidationUseCase(
                {
                    getTypeIntegration: jest.fn().mockResolvedValue('github'),
                } as any,
                {
                    findIntegrationConfigFormatted: jest
                        .fn()
                        .mockResolvedValue([]),
                } as any,
                service as any,
                publisher as any,
                runs as any,
            );

            const result = await cli.execute({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                input: { diff: '+x', taskId: 'AB#8' },
            });

            expect(service.validate).toHaveBeenCalledWith(
                expect.objectContaining({
                    door: 'cli',
                    taskInput: 'AB#8',
                    diff: '+x',
                }),
            );
            expect(result.result).toContain('MISSING');
            expect(result.result).toContain('src/settings/density.ts:6');
            expect(result.result).toContain('status: issues_found');
            expect(result.verdict).toMatchObject({
                status: 'issues_found',
                passed: false,
                tasks: [
                    expect.objectContaining({
                        id: 'AB#8',
                        requirements: [
                            expect.objectContaining({ state: 'missing' }),
                        ],
                    }),
                ],
            });
            expect(runs.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    door: 'cli',
                    outcome: 'validated',
                    passed: false,
                }),
            );
            expect(publisher.publish).not.toHaveBeenCalled();
        });
    });
});

describe('TriggerBusinessValidationUseCase.testOnPullRequest', () => {
    const prUrl = 'https://github.com/acme/notes/pull/47';
    const outcome = {
        kind: 'validated' as const,
        checks: [
            {
                task: {
                    tracker: 'Linear',
                    id: 'SAA-96',
                    title: 'Sticky notes',
                    description: 'Drag to reorder',
                    acceptanceCriteria: ['Order persists'],
                },
                verdict: {
                    needsMoreInfo: false,
                    summary: '',
                    requirements: [
                        {
                            requirement: 'Order persists',
                            state: 'missing' as const,
                            evidence: [],
                            confidence: 'high' as const,
                        },
                    ],
                    outOfScope: [],
                },
                passed: false,
                readAt: '2026-10-07T12:00:00.000Z',
            },
        ],
        thinTasks: [],
        passed: false,
        unseenFiles: [],
    };

    function build(prNumber = 47) {
        const code = {
            getTypeIntegration: jest.fn(async () => 'GITHUB'),
            getPullRequests: jest.fn(async () => [
                {
                    number: prNumber,
                    prURL: `https://github.com/acme/notes/pull/${prNumber}`,
                    title: 'Sticky notes: drag to reorder',
                    body: 'Closes SAA-96',
                    repositoryData: { id: 'repo-1', name: 'acme/notes' },
                    head: {
                        ref: 'feat/SAA-96',
                        repo: { fullName: 'acme/notes', name: 'notes' },
                    },
                    base: { ref: 'main' },
                },
            ]),
        };
        const service = {
            validate: jest.fn(async () => ({
                outcome,
                references: [
                    {
                        kind: 'key',
                        id: 'SAA-96',
                        raw: 'SAA-96',
                        source: 'body',
                        intent: 'closes',
                    },
                ],
                attempts: [
                    {
                        reference: 'SAA-96',
                        tracker: 'Linear',
                        status: 'found',
                        tools: ['get_issue'],
                    },
                ],
                trackers: ['Linear'],
            })),
        };
        const publisher = {
            configFor: jest.fn(async () => ({
                settings: {},
                enabled: true,
                byokModelId: 'model-dir',
            })),
            withRepository: jest.fn((r: unknown) => r),
            headShaOf: jest.fn(async () => 'abc1234'),
            preview: jest.fn(async () => ({
                outcome,
                comment: { posted: true, editsExisting: false, body: 'body' },
                check: {
                    supported: true,
                    conclusion: 'failure',
                    title: '1 missing',
                },
            })),
            publish: jest.fn(async () => ({ outcome, comment: 'created' })),
        };
        const runs = { create: jest.fn() };
        const integrationConfig = {
            findIntegrationConfigFormatted: jest.fn(async () => [
                { id: 'repo-1', name: 'notes', organizationName: 'acme' },
            ]),
        };
        const useCase = new TriggerBusinessValidationUseCase(
            code as any,
            integrationConfig as any,
            service as any,
            publisher as any,
            runs as any,
        );
        return { useCase, service, publisher, runs };
    }

    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    it('runs with the settings on screen and writes nothing', async () => {
        const { useCase, service, publisher, runs } = build();

        const result = await useCase.testOnPullRequest({
            organizationAndTeamData,
            prUrl,
            settings: { recheckOn: 'push' },
        });

        expect(service.validate).toHaveBeenCalledWith(
            expect.objectContaining({
                pullRequest: expect.objectContaining({
                    number: 47,
                    body: 'Closes SAA-96',
                }),
                settings: expect.objectContaining({ recheckOn: 'push' }),
            }),
        );
        // The list names it `acme/notes`; the diff needs the stored name.
        expect(service.validate).toHaveBeenCalledWith(
            expect.objectContaining({
                repository: expect.objectContaining({
                    name: 'notes',
                    owner: 'acme',
                }),
            }),
        );
        expect(result.pullRequest.repositoryName).toBe('notes');
        // The settings on screen, with the model the PR's review uses.
        expect(service.validate).toHaveBeenCalledWith(
            expect.objectContaining({ byokModelId: 'model-dir' }),
        );
        expect(publisher.publish).not.toHaveBeenCalled();
        expect(runs.create).not.toHaveBeenCalled();
        expect(result.attempts[0].tools).toEqual(['get_issue']);
        expect(result.tasks[0]).toMatchObject({
            id: 'SAA-96',
            criteria: ['Order persists'],
        });
        expect(result.comment.posted).toBe(true);
        expect(result.previewToken).toEqual(expect.any(String));
    });

    it('posts the result the preview showed, sealed, without running it again', async () => {
        const { useCase, publisher, service } = build();
        const preview = await useCase.testOnPullRequest({
            organizationAndTeamData,
            prUrl,
        });
        expect(service.validate).toHaveBeenCalledTimes(1);

        const authorize = jest.fn(async () => undefined);
        const result = await useCase.postPreview({
            organizationAndTeamData,
            previewToken: preview.previewToken,
            authorize,
        });

        expect(service.validate).toHaveBeenCalledTimes(1);
        expect(authorize).toHaveBeenCalledWith('repo-1');
        expect(publisher.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                trigger: 'command',
                headSha: 'abc1234',
                request: expect.objectContaining({
                    pullRequest: expect.objectContaining({ number: 47 }),
                }),
            }),
        );
        expect(result).toEqual({ posted: 'created' });
    });

    it('refuses a preview another team made, or one that was altered', async () => {
        const { useCase, publisher } = build();
        const { previewToken } = await useCase.testOnPullRequest({
            organizationAndTeamData,
            prUrl,
        });
        await expect(
            useCase.postPreview({
                organizationAndTeamData: {
                    ...organizationAndTeamData,
                    teamId: 'team-2',
                },
                previewToken,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
            useCase.postPreview({
                organizationAndTeamData,
                previewToken: `x${previewToken}`,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(publisher.publish).not.toHaveBeenCalled();
    });

    it('never runs on another PR than the one asked for', async () => {
        const { useCase, service } = build(12);

        await expect(
            useCase.testOnPullRequest({ organizationAndTeamData, prUrl }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(service.validate).not.toHaveBeenCalled();
    });
});

describe('TriggerBusinessValidationUseCase.tryReadTask', () => {
    it("reads `#12` in the repository's namespace, not the GitLab group's display name", async () => {
        const service = { tryRead: jest.fn(async () => ({ status: 'found' })) };
        const integrationConfig = {
            findIntegrationConfigFormatted: jest.fn(async () => [
                {
                    id: 'repo-1',
                    name: 'acme-corp/notes',
                    full_name: 'acme-corp/notes',
                    organizationName: 'Acme Corp',
                },
            ]),
        };
        const useCase = new TriggerBusinessValidationUseCase(
            {} as any,
            integrationConfig as any,
            service as any,
            {} as any,
            {} as any,
        );

        await useCase.tryReadTask({
            organizationAndTeamData: { organizationId: 'org-1', teamId: 't' },
            task: '#12',
            repositoryId: 'repo-1',
        });

        expect(service.tryRead).toHaveBeenCalledWith(
            expect.anything(),
            '#12',
            expect.anything(),
            { owner: 'acme-corp', name: 'notes' },
        );
    });
});
