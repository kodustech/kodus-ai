import {
    freezeAgentFileRule,
    freezeAgentFileRules,
    ONBOARDING_IMPORT_REMOVED_REASON,
    restoreAgentFileRule,
    restoreAgentFileRules,
} from './freeze-agent-file-rules';

const onboardingRule = (over: Record<string, unknown> = {}) => ({
    uuid: 'r1',
    origin: 'repo_file_sync',
    repositoryId: 'global',
    sourcePath: 'CLAUDE.md',
    status: 'active',
    ...over,
});

describe('freezeAgentFileRule', () => {
    it.each([
        ['a coding-agent file', 'CLAUDE.md'],
        ['a nested coding-agent file', 'apps/api/.cursor/rules/style.mdc'],
        ['a dependency manifest', 'package.json'],
        ['no source file', undefined],
    ])('deletes an onboarding import from %s', (_label, sourcePath) => {
        expect(freezeAgentFileRule(onboardingRule({ sourcePath }))).toEqual(
            expect.objectContaining({
                status: 'deleted',
                reason: ONBOARDING_IMPORT_REMOVED_REASON,
                previousStatus: 'active',
            }),
        );
    });

    it.each(['pending', 'paused'])(
        'deletes an onboarding import that is %s, keeping its status to restore',
        (status) => {
            expect(freezeAgentFileRule(onboardingRule({ status }))).toEqual(
                expect.objectContaining({
                    status: 'deleted',
                    previousStatus: status,
                }),
            );
        },
    );

    it('leaves an onboarding import of a Kody rule template alone', () => {
        expect(
            freezeAgentFileRule(
                onboardingRule({ sourcePath: '.kody/rules/no-console.md' }),
            ),
        ).toBeNull();
    });

    it.each(['deleted', 'rejected'])(
        'leaves an onboarding import that is already %s alone',
        (status) => {
            expect(freezeAgentFileRule(onboardingRule({ status }))).toBeNull();
        },
    );

    it('leaves rules a team synced on purpose (repository scope)', () => {
        expect(
            freezeAgentFileRule(onboardingRule({ repositoryId: 'repo-1' })),
        ).toBeNull();
    });

    it('leaves rules from a global source repository', () => {
        expect(
            freezeAgentFileRule(
                onboardingRule({
                    origin: 'global_repo_file_sync',
                    sourceRepositoryId: 'repo-9',
                }),
            ),
        ).toBeNull();
        expect(
            freezeAgentFileRule(
                onboardingRule({ sourceRepositoryId: 'repo-9' }),
            ),
        ).toBeNull();
    });

    it('leaves manual, library and generated rules alone', () => {
        for (const origin of ['manual', 'library', 'past_reviews']) {
            expect(freezeAgentFileRule(onboardingRule({ origin }))).toBeNull();
        }
    });

    it('clears the @kody-sync pin on every rule', () => {
        expect(
            freezeAgentFileRule({
                origin: 'repo_file_sync',
                repositoryId: 'repo-1',
                sourcePath: '.kody/rules/a.md',
                status: 'active',
                pinnedSync: true,
            }),
        ).toEqual(
            expect.objectContaining({ pinnedSync: false, status: 'active' }),
        );
    });

    it('is idempotent', () => {
        const once = freezeAgentFileRule(onboardingRule({ pinnedSync: true }));
        expect(freezeAgentFileRule(once)).toBeNull();
    });
});

describe('restoreAgentFileRule', () => {
    it('puts a removed onboarding import back in its previous status', () => {
        const removed = freezeAgentFileRule(
            onboardingRule({ status: 'paused' }),
        );
        const restored = restoreAgentFileRule(removed);

        expect(restored).toEqual(
            expect.objectContaining({ uuid: 'r1', status: 'paused' }),
        );
        expect(restored).not.toHaveProperty('previousStatus');
        expect(restored).not.toHaveProperty('reason');
    });

    it('leaves a rule the user deleted alone', () => {
        expect(
            restoreAgentFileRule(onboardingRule({ status: 'deleted' })),
        ).toBeNull();
    });
});

describe('freezeAgentFileRules', () => {
    const fakeDb = (docs: any[]) => {
        const updateOne = jest.fn().mockResolvedValue({});
        return {
            updateOne,
            db: {
                collection: () => ({
                    find: () => ({
                        async *[Symbol.asyncIterator]() {
                            yield* docs;
                        },
                    }),
                    updateOne,
                }),
            } as any,
        };
    };

    it('rewrites only the documents that change and reports per-org counts', async () => {
        const { db, updateOne } = fakeDb([
            {
                _id: 'd1',
                organizationId: 'org-1',
                rules: [
                    onboardingRule(),
                    onboardingRule({
                        uuid: 'r2',
                        sourcePath: '.kody/rules/a.md',
                    }),
                    { uuid: 'r3', origin: 'manual', pinnedSync: true },
                ],
            },
            {
                _id: 'd2',
                organizationId: 'org-2',
                rules: [{ uuid: 'r4', origin: 'manual' }],
            },
        ]);

        const result = await freezeAgentFileRules(db);

        expect(updateOne).toHaveBeenCalledTimes(1);
        const [filter, update] = updateOne.mock.calls[0];
        expect(filter).toEqual({ _id: 'd1' });
        expect(update.$set.rules.map((r: any) => r.status)).toEqual([
            'deleted',
            'active',
            undefined,
        ]);
        expect(result).toEqual({
            docsScanned: 2,
            docsUpdated: 1,
            removed: 1,
            pinsCleared: 1,
            orgsWithRemoved: ['org-1'],
        });
    });

    it('writes nothing on a dry run', async () => {
        const { db, updateOne } = fakeDb([
            { _id: 'd1', organizationId: 'org-1', rules: [onboardingRule()] },
        ]);

        const result = await freezeAgentFileRules(db, { dryRun: true });

        expect(updateOne).not.toHaveBeenCalled();
        expect(result.removed).toBe(1);
    });

    it('restoreAgentFileRules undoes the removal', async () => {
        const removed = freezeAgentFileRule(onboardingRule());
        const { db, updateOne } = fakeDb([
            {
                _id: 'd1',
                organizationId: 'org-1',
                rules: [
                    removed,
                    onboardingRule({ uuid: 'r2', status: 'deleted' }),
                ],
            },
        ]);

        const result = await restoreAgentFileRules(db);

        const [, update] = updateOne.mock.calls[0];
        expect(update.$set.rules.map((r: any) => r.status)).toEqual([
            'active',
            'deleted',
        ]);
        expect(result.restored).toBe(1);
    });

    it('restoreAgentFileRules can restore a single organization', async () => {
        const find = jest.fn(() => ({
            async *[Symbol.asyncIterator]() {},
        }));
        const db = {
            collection: () => ({ find, updateOne: jest.fn() }),
        } as any;

        await restoreAgentFileRules(db, { organizationId: 'org-7' });

        expect(find).toHaveBeenCalledWith({ organizationId: 'org-7' });
    });
});
