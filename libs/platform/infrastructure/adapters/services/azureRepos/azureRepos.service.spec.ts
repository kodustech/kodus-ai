import { AzureReposService } from './azureRepos.service';

/**
 * Regression test for issue #1045 / Bug B — Azure DevOps' API uses
 * `description` for the PR body field while every other platform (and
 * Kodus' domain) uses `body`. Without normalization at the adapter
 * boundary, consumers like CommentManagerService.generateSummaryPR
 * read `updatedPR?.body`, get `undefined`, and the CONCATENATE branch
 * silently drops the user's existing description (we replace instead
 * of concatenate).
 *
 * The fix in `getPullRequestByNumber` spreads `{ ...pr, body: pr.description ?? '' }`
 * so callers never have to know about Azure's quirk.
 */
describe('AzureReposService.getPullRequestByNumber — body/description normalization (issue #1045)', () => {
    let service: AzureReposService;
    let azureReposRequestHelper: { getPullRequestDetails: jest.Mock };

    const stubRepository = {
        id: 'repo-uuid-123',
        name: 'sample-repo',
        project: { id: 'project-uuid-456' },
    };

    const stubOrg = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    beforeEach(() => {
        azureReposRequestHelper = {
            getPullRequestDetails: jest.fn(),
        };

        service = new AzureReposService(
            {} as any, // integrationService
            {} as any, // integrationConfigService
            {} as any, // authIntegrationService
            azureReposRequestHelper as any,
            {} as any, // configService
            undefined, // mcpManagerService (optional)
        );

        // The two helpers run before the SDK call. Stub them so we can
        // exercise the field-mapping code path directly.
        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
            orgName: 'fake-org',
            token: 'fake-token',
        });
        jest.spyOn(service as any, 'getProjectIdFromRepository').mockResolvedValue(
            stubRepository.project.id,
        );
    });

    it('maps Azure `description` onto `body` while preserving the original `description` field', async () => {
        azureReposRequestHelper.getPullRequestDetails.mockResolvedValue({
            id: 42,
            description: 'PR body text from the user',
            title: 'feat: add SSO',
            status: 'active',
            repository: stubRepository,
        });

        const result = await service.getPullRequestByNumber({
            organizationAndTeamData: stubOrg,
            repository: stubRepository,
            prNumber: 42,
        });

        expect(result?.body).toBe('PR body text from the user');
        // Spread keeps `description` reachable for any caller still on
        // the Azure-shaped contract.
        expect(result?.description).toBe('PR body text from the user');
        // And the rest of the object survives intact.
        expect(result?.id).toBe(42);
        expect(result?.title).toBe('feat: add SSO');
        expect(result?.repository).toEqual(stubRepository);
    });

    it('coerces a null description into an empty string body', async () => {
        azureReposRequestHelper.getPullRequestDetails.mockResolvedValue({
            id: 100,
            description: null,
            title: 'chore: empty description',
        });

        const result = await service.getPullRequestByNumber({
            organizationAndTeamData: stubOrg,
            repository: stubRepository,
            prNumber: 100,
        });

        expect(result?.body).toBe('');
        expect(result?.description).toBeNull();
    });

    it('coerces an undefined description into an empty string body', async () => {
        azureReposRequestHelper.getPullRequestDetails.mockResolvedValue({
            id: 101,
            // No `description` field at all on this Azure response.
            title: 'chore: missing description field',
        });

        const result = await service.getPullRequestByNumber({
            organizationAndTeamData: stubOrg,
            repository: stubRepository,
            prNumber: 101,
        });

        expect(result?.body).toBe('');
    });

    it('returns null when the upstream helper returns null (no PR found)', async () => {
        azureReposRequestHelper.getPullRequestDetails.mockResolvedValue(null);

        const result = await service.getPullRequestByNumber({
            organizationAndTeamData: stubOrg,
            repository: stubRepository,
            prNumber: 999,
        });

        expect(result).toBeNull();
    });

    it('returns null when the upstream helper throws (mirrors the catch in the implementation)', async () => {
        azureReposRequestHelper.getPullRequestDetails.mockRejectedValue(
            new Error('Azure DevOps unreachable'),
        );

        const result = await service.getPullRequestByNumber({
            organizationAndTeamData: stubOrg,
            repository: stubRepository,
            prNumber: 42,
        });

        expect(result).toBeNull();
    });

    /**
     * Anti-regression — the bug shape this test guards against is:
     * the method returning the raw Azure object without mapping
     * description→body, leaving downstream consumers with
     * `pr.body === undefined`. If anyone refactors and forgets the
     * spread, this assertion fails immediately.
     */
    it('does NOT regress to returning the raw Azure object (anti-regression)', async () => {
        azureReposRequestHelper.getPullRequestDetails.mockResolvedValue({
            id: 1,
            description: 'something',
        });

        const result = await service.getPullRequestByNumber({
            organizationAndTeamData: stubOrg,
            repository: stubRepository,
            prNumber: 1,
        });

        expect(result).toHaveProperty('body');
        expect(result?.body).not.toBeUndefined();
    });
});

/**
 * Characterization tests for `AzureReposService.getFilesByPullRequestId`.
 *
 * These pin down the CURRENT behavior of the method before the refactor that
 * caps Azure DevOps fan-out concurrency via `p-limit`.
 *
 * Why characterization tests: the production incident (self-hosted, large
 * Discourse PR with ~200 files) showed that `getFilesByPullRequestId` fires
 * 1-2 `getFileContent` requests per file via `Promise.all`, with no
 * concurrency cap. The same code path runs in cloud, but there it's masked
 * by horizontal worker replicas + better bandwidth/peering. We want to
 * refactor without changing the observable contract for existing callers
 * (notably `pullRequest.controller.ts` which reads `patch` off the result).
 *
 * Each test below documents one behavior the refactor MUST preserve. The
 * accompanying Phase 2 suite (`getFilesByPullRequestId — refactor`) adds
 * tests for the new behavior (metadata-only mode + concurrency bounded
 * fan-out) and runs against the same fixtures.
 */
describe('AzureReposService.getFilesByPullRequestId — current behavior (characterization)', () => {
    let service: AzureReposService;
    let azureReposRequestHelper: {
        getPullRequestDetails: jest.Mock;
        getIterations: jest.Mock;
        getChanges: jest.Mock;
        getFileContent: jest.Mock;
        mapAzureStatusToFileChangeStatus: jest.Mock;
    };

    const stubOrg = { organizationId: 'org-1', teamId: 'team-1' };
    const stubRepository = { id: 'repo-uuid-123', name: 'sample-repo' };
    const BASE_COMMIT = 'base-commit-sha';
    const TARGET_COMMIT = 'target-commit-sha';

    // Builds a PR-details response shaped the way the Azure SDK returns it.
    const prDetails = () => ({
        id: 42,
        lastMergeTargetCommit: { commitId: BASE_COMMIT },
        lastMergeSourceCommit: { commitId: TARGET_COMMIT },
    });

    // Builds an Azure `changes` entry for one file. Azure returns these with
    // an `item.path` and a `changeType`; `originalPath` only appears for
    // renames. The defaults match the most common case (edit).
    const changeEntry = (
        path: string,
        changeType: 'edit' | 'add' | 'delete' | 'rename' = 'edit',
        originalPath?: string,
    ) => ({
        item: { path },
        changeType,
        ...(originalPath ? { originalPath } : {}),
    });

    beforeEach(() => {
        azureReposRequestHelper = {
            getPullRequestDetails: jest.fn().mockResolvedValue(prDetails()),
            getIterations: jest
                .fn()
                .mockResolvedValue([{ id: 1 }, { id: 2 }]),
            getChanges: jest.fn().mockResolvedValue([]),
            getFileContent: jest
                .fn()
                .mockResolvedValue({ content: 'default content' }),
            // The real helper maps Azure's verbs to FileChange's status union.
            // For these tests we use the same naming so assertions stay
            // readable; a real `rename` would map to 'renamed', etc.
            mapAzureStatusToFileChangeStatus: jest.fn((t: string) => {
                if (t === 'add') return 'added';
                if (t === 'delete') return 'removed';
                if (t === 'rename') return 'renamed';
                return 'modified';
            }),
        };

        service = new AzureReposService(
            {} as any,
            {} as any,
            {} as any,
            azureReposRequestHelper as any,
            {} as any,
            undefined,
        );

        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
            orgName: 'fake-org',
            token: 'fake-token',
        });
        jest.spyOn(
            service as any,
            'getProjectIdFromRepository',
        ).mockResolvedValue('project-uuid-456');
    });

    it('returns one FileChange per change entry, populated with patch + content (happy path)', async () => {
        azureReposRequestHelper.getChanges.mockResolvedValue([
            changeEntry('/src/foo.ts'),
            changeEntry('/src/bar.ts'),
            changeEntry('/src/baz.ts'),
        ]);
        azureReposRequestHelper.getFileContent.mockImplementation(
            ({ filePath, commitId }) => ({
                content:
                    commitId === BASE_COMMIT
                        ? `original of ${filePath}`
                        : `modified of ${filePath}`,
            }),
        );

        const result = await service.getFilesByPullRequestId({
            organizationAndTeamData: stubOrg as any,
            repository: stubRepository,
            prNumber: 42,
        });

        expect(result).toHaveLength(3);
        expect(result?.map((f) => f.filename).sort()).toEqual([
            '/src/bar.ts',
            '/src/baz.ts',
            '/src/foo.ts',
        ]);

        // Each result MUST carry the populated patch + content — this is the
        // observable contract that `pullRequest.controller.ts` and the
        // review pipeline depend on today.
        for (const f of result!) {
            expect(f.patch).toEqual(expect.any(String));
            expect(f.patch.length).toBeGreaterThan(0);
            expect(f.content).toEqual(expect.stringContaining('modified of'));
            expect(f.status).toBe('modified');
        }
    });

    it('issues TWO getFileContent calls per edited file (original + modified)', async () => {
        azureReposRequestHelper.getChanges.mockResolvedValue([
            changeEntry('/a.ts'),
            changeEntry('/b.ts'),
            changeEntry('/c.ts'),
        ]);

        await service.getFilesByPullRequestId({
            organizationAndTeamData: stubOrg as any,
            repository: stubRepository,
            prNumber: 42,
        });

        // 3 files × 2 calls (base + target) = 6. This is the per-file cost
        // that explodes on large PRs.
        expect(azureReposRequestHelper.getFileContent).toHaveBeenCalledTimes(6);
    });

    it('skips the base-commit fetch for added files (1 call, not 2)', async () => {
        azureReposRequestHelper.getChanges.mockResolvedValue([
            changeEntry('/new.ts', 'add'),
        ]);

        await service.getFilesByPullRequestId({
            organizationAndTeamData: stubOrg as any,
            repository: stubRepository,
            prNumber: 42,
        });

        expect(azureReposRequestHelper.getFileContent).toHaveBeenCalledTimes(1);
        expect(azureReposRequestHelper.getFileContent).toHaveBeenCalledWith(
            expect.objectContaining({ commitId: TARGET_COMMIT }),
        );
    });

    it('skips the target-commit fetch for deleted files (1 call, not 2)', async () => {
        azureReposRequestHelper.getChanges.mockResolvedValue([
            changeEntry('/gone.ts', 'delete'),
        ]);

        await service.getFilesByPullRequestId({
            organizationAndTeamData: stubOrg as any,
            repository: stubRepository,
            prNumber: 42,
        });

        expect(azureReposRequestHelper.getFileContent).toHaveBeenCalledTimes(1);
        expect(azureReposRequestHelper.getFileContent).toHaveBeenCalledWith(
            expect.objectContaining({ commitId: BASE_COMMIT }),
        );
    });

    it('returns an empty array when the PR has no iterations', async () => {
        azureReposRequestHelper.getIterations.mockResolvedValue([]);

        const result = await service.getFilesByPullRequestId({
            organizationAndTeamData: stubOrg as any,
            repository: stubRepository,
            prNumber: 42,
        });

        expect(result).toEqual([]);
        // Empty iterations short-circuit before getChanges/getFileContent.
        expect(azureReposRequestHelper.getChanges).not.toHaveBeenCalled();
        expect(azureReposRequestHelper.getFileContent).not.toHaveBeenCalled();
    });

    it('returns null when the repository has no resolvable projectId', async () => {
        jest.spyOn(
            service as any,
            'getProjectIdFromRepository',
        ).mockResolvedValue(null);

        const result = await service.getFilesByPullRequestId({
            organizationAndTeamData: stubOrg as any,
            repository: stubRepository,
            prNumber: 42,
        });

        // The outer try/catch swallows the thrown NotFoundException and
        // returns null. Preserving null (vs throw) matters because callers
        // like `pullRequestManager.getChangedFilesMetadata` propagate the
        // error one layer up, and the AMQP retry logic depends on this shape.
        expect(result).toBeNull();
    });

    it('treats a 404 on file content as empty content but STILL includes the file', async () => {
        azureReposRequestHelper.getChanges.mockResolvedValue([
            changeEntry('/known.ts'),
            changeEntry('/deleted-mid-pr.ts'),
        ]);
        azureReposRequestHelper.getFileContent.mockImplementation(
            ({ filePath }) => {
                if (filePath === '/deleted-mid-pr.ts') {
                    const err: any = new Error('Not Found');
                    err.status = 404;
                    throw err;
                }
                return { content: `content of ${filePath}` };
            },
        );

        const result = await service.getFilesByPullRequestId({
            organizationAndTeamData: stubOrg as any,
            repository: stubRepository,
            prNumber: 42,
        });

        // 404 is a known/expected case (file may have been renamed away or
        // removed since the iteration was snapshot). The adapter keeps the
        // FileChange entry with empty content so the pipeline sees the
        // change but doesn't try to LLM-review an absent body.
        expect(result?.map((f) => f.filename).sort()).toEqual([
            '/deleted-mid-pr.ts',
            '/known.ts',
        ]);
    });

    it('drops a single file with a non-404 error but keeps the rest of the batch', async () => {
        azureReposRequestHelper.getChanges.mockResolvedValue([
            changeEntry('/ok-1.ts'),
            changeEntry('/exploding.ts'),
            changeEntry('/ok-2.ts'),
        ]);
        azureReposRequestHelper.getFileContent.mockImplementation(
            ({ filePath }) => {
                if (filePath === '/exploding.ts') {
                    // Anything non-404 — timeout, 500, network — propagates
                    // out of the inner try and gets caught by the per-file
                    // outer try, which returns null for that file only.
                    throw new Error('timeout of 60000ms exceeded');
                }
                return { content: `content of ${filePath}` };
            },
        );

        const result = await service.getFilesByPullRequestId({
            organizationAndTeamData: stubOrg as any,
            repository: stubRepository,
            prNumber: 42,
        });

        // Critical: the current method is NOT fail-fast. Promise.all resolves
        // because `_generateFileDiffForAzure` catches its own errors and
        // returns null; the `.filter(f => f !== null)` afterwards drops them
        // SILENTLY. The refactor must preserve this resilience (otherwise
        // a single flaky file would kill the whole review).
        expect(result?.map((f) => f.filename).sort()).toEqual([
            '/ok-1.ts',
            '/ok-2.ts',
        ]);
    });

    it('skips change entries that have neither item.path nor originalPath', async () => {
        azureReposRequestHelper.getChanges.mockResolvedValue([
            changeEntry('/real.ts'),
            { changeType: 'edit' }, // no item, no originalPath — junk entry
            { item: {}, changeType: 'edit' }, // item without path
        ]);

        const result = await service.getFilesByPullRequestId({
            organizationAndTeamData: stubOrg as any,
            repository: stubRepository,
            prNumber: 42,
        });

        expect(result?.map((f) => f.filename)).toEqual(['/real.ts']);
        // Confirms the junk entries didn't trigger any HTTP — they were
        // filtered before `_generateFileDiffForAzure` ran.
        expect(azureReposRequestHelper.getFileContent).toHaveBeenCalledTimes(2);
    });
});

/**
 * Refactor tests for `getFilesByPullRequestId` — bounded fan-out.
 *
 * The per-file diff generation runs through a `pLimit(N)` gate so a
 * 200-file PR can't fire 400 concurrent HTTPs at Azure DevOps. Matches
 * the pattern used in `pullRequestManager.enrichFilesWithContent`.
 */
describe('AzureReposService.getFilesByPullRequestId — bounded fan-out', () => {
    let service: AzureReposService;
    let azureReposRequestHelper: {
        getPullRequestDetails: jest.Mock;
        getIterations: jest.Mock;
        getChanges: jest.Mock;
        getFileContent: jest.Mock;
        mapAzureStatusToFileChangeStatus: jest.Mock;
    };

    const stubOrg = { organizationId: 'org-1', teamId: 'team-1' };
    const stubRepository = { id: 'repo-uuid-123', name: 'sample-repo' };
    const BASE_COMMIT = 'base-commit-sha';
    const TARGET_COMMIT = 'target-commit-sha';

    const prDetails = () => ({
        id: 42,
        lastMergeTargetCommit: { commitId: BASE_COMMIT },
        lastMergeSourceCommit: { commitId: TARGET_COMMIT },
    });

    const changeEntry = (
        path: string,
        changeType: 'edit' | 'add' | 'delete' | 'rename' = 'edit',
    ) => ({ item: { path }, changeType });

    beforeEach(() => {
        azureReposRequestHelper = {
            getPullRequestDetails: jest.fn().mockResolvedValue(prDetails()),
            getIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
            getChanges: jest.fn().mockResolvedValue([]),
            getFileContent: jest
                .fn()
                .mockResolvedValue({ content: 'default content' }),
            mapAzureStatusToFileChangeStatus: jest.fn((t: string) => {
                if (t === 'add') return 'added';
                if (t === 'delete') return 'removed';
                return 'modified';
            }),
        };

        service = new AzureReposService(
            {} as any,
            {} as any,
            {} as any,
            azureReposRequestHelper as any,
            {} as any,
            undefined,
        );

        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
            orgName: 'fake-org',
            token: 'fake-token',
        });
        jest.spyOn(
            service as any,
            'getProjectIdFromRepository',
        ).mockResolvedValue('project-uuid-456');
    });

    describe('bounded concurrency (p-limit fan-out cap)', () => {
        it('never has more than CONCURRENCY_CAP in-flight getFileContent calls', async () => {
            // Pick a file count well above the expected cap so the test
            // actually exercises the gate. 30 is the established cap in
            // `pullRequestManager.FILE_CONTENT_CONCURRENCY`; we accept up
            // to that as the upper bound. If the refactor regresses to
            // unbounded Promise.all, this assertion catches it.
            const CONCURRENCY_CAP = 30;
            const TOTAL_FILES = 60;

            azureReposRequestHelper.getChanges.mockResolvedValue(
                Array.from({ length: TOTAL_FILES }, (_, i) =>
                    changeEntry(`/file-${i}.ts`),
                ),
            );

            let inFlight = 0;
            let peakInFlight = 0;
            azureReposRequestHelper.getFileContent.mockImplementation(
                async () => {
                    inFlight++;
                    peakInFlight = Math.max(peakInFlight, inFlight);
                    // Yield so other in-flight promises can run before this
                    // one resolves — without this, sync resolution would
                    // hide the concurrency issue entirely.
                    await new Promise((r) => setImmediate(r));
                    inFlight--;
                    return { content: 'x' };
                },
            );

            await service.getFilesByPullRequestId({
                organizationAndTeamData: stubOrg as any,
                repository: stubRepository,
                prNumber: 42,
            });

            // With unbounded Promise.all + 60 files × 2 calls, peak would be
            // ~120. With pLimit(30), peak ≤ 30. We assert ≤ cap because
            // the inner `_generateFileDiffForAzure` makes 2 sequential
            // calls per file under the same slot, so actual peak is ≤ cap.
            expect(peakInFlight).toBeLessThanOrEqual(CONCURRENCY_CAP);
        });
    });
});
