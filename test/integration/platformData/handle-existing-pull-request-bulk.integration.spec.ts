/**
 * INTEGRATION TEST for issue #1107 — exercises
 * `handleExistingPullRequest` against a real MongoDB instance and
 * asserts post-conditions on the persisted document.
 *
 * Why this exists: the unit tests prove the service builds the
 * right `FileBulkOp[]`, but the real win of the fix lives in two
 * places that only show up against Mongo:
 *   1. the `bulkWrite` translation actually persists updates and
 *      pushes onto sub-arrays the way we expect; and
 *   2. `computeFileTotals` returns the same shape the projection
 *      would have computed in memory.
 *
 * Synthetic data only — no customer info. Skipped unless
 * `TEST_MONGODB_URI` is set so CI doesn't depend on a live Mongo.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
    PullRequestsModel,
    PullRequestsSchema,
} from '@libs/platformData/infrastructure/adapters/repositories/schemas/pullRequests.model';
import { PullRequestsRepository } from '@libs/platformData/infrastructure/adapters/repositories/pullRequests.repository';
import { PullRequestsService } from '@libs/platformData/infrastructure/adapters/services/pullRequests.service';
import { PULL_REQUESTS_REPOSITORY_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.repository';

const MONGODB_URI =
    process.env.TEST_MONGODB_URI || process.env.API_MG_DB_HOST;
const shouldSkip = !MONGODB_URI;

(shouldSkip ? describe.skip : describe)(
    'handleExistingPullRequest — bulkWrite persistence (issue #1107)',
    () => {
        let module: TestingModule;
        let service: PullRequestsService;
        let repository: PullRequestsRepository;
        let model: Model<PullRequestsModel>;

        const TEST_ORG_ID = 'test-org-1107-' + Date.now();
        const TEST_TEAM_ID = 'test-team-1107-' + Date.now();
        const REPO = {
            id: 'repo-1107',
            name: 'synthetic-repo',
            fullName: 'org/synthetic-repo',
            language: 'TypeScript',
            url: 'https://example.invalid/synthetic-repo',
        };

        beforeAll(async () => {
            const mongoUri = MONGODB_URI?.includes('://')
                ? MONGODB_URI
                : `mongodb://${MONGODB_URI}:27017/kodus_test_1107`;

            module = await Test.createTestingModule({
                imports: [
                    MongooseModule.forRoot(mongoUri),
                    MongooseModule.forFeature([
                        {
                            name: PullRequestsModel.name,
                            schema: PullRequestsSchema,
                        },
                    ]),
                ],
                providers: [
                    {
                        provide: PULL_REQUESTS_REPOSITORY_TOKEN,
                        useClass: PullRequestsRepository,
                    },
                    PullRequestsRepository,
                    {
                        provide: PullRequestsService,
                        useFactory: (repo: PullRequestsRepository) =>
                            new PullRequestsService(repo, {} as any),
                        inject: [PullRequestsRepository],
                    },
                ],
            }).compile();

            service = module.get(PullRequestsService);
            repository = module.get(PullRequestsRepository);
            model = module.get(getModelToken(PullRequestsModel.name));

            // Silence logger to keep CI output clean.
            (service as any).logger = {
                log: () => {},
                warn: () => {},
                error: () => {},
                debug: () => {},
            };
        });

        afterAll(async () => {
            if (model) {
                await model.deleteMany({ organizationId: TEST_ORG_ID });
            }
            if (module) await module.close();
        });

        async function seedExistingPR(opts: {
            number: number;
            files: any[];
        }) {
            // The entity's `uuid` is the mongoose `_id` exposed as a
            // string by the simple-mapper — there is no separate
            // `uuid` column in this collection. Mirror that here.
            const created = (await model.create({
                number: opts.number,
                title: 'Synthetic PR for #1107 regression',
                status: 'opened',
                merged: false,
                organizationId: TEST_ORG_ID,
                repository: REPO,
                files: opts.files,
                commits: [],
                totalAdded: 0,
                totalDeleted: 0,
                totalChanges: 0,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            } as any)) as any;
            const uuid = created._id.toString();
            return {
                uuid,
                number: opts.number,
                files: opts.files,
            } as any;
        }

        function callHandleExisting(
            existingPR: any,
            changedFiles: any[],
            prioritized: any[] = [],
        ) {
            return (service as any).handleExistingPullRequest(
                existingPR,
                { number: existingPR.number },
                REPO,
                changedFiles,
                prioritized,
                [],
                { organizationId: TEST_ORG_ID, teamId: TEST_TEAM_ID },
            );
        }

        it('updates existing files in-place (same id, new metrics) and pushes new files onto the array', async () => {
            const existingFileId = repository.newSubDocumentId();
            const existingPR = await seedExistingPR({
                number: 1001,
                files: [
                    {
                        id: existingFileId,
                        path: 'src/keep.ts',
                        filename: 'keep.ts',
                        previousName: '',
                        sha: 'old-sha',
                        status: 'modified',
                        suggestions: [],
                        added: 1,
                        deleted: 1,
                        changes: 2,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    },
                ],
            });

            await callHandleExisting(existingPR, [
                {
                    filename: 'src/keep.ts',
                    sha: 'new-sha',
                    additions: 7,
                    deletions: 3,
                    changes: 10,
                    status: 'modified',
                    patch: '@@ updated',
                },
                {
                    filename: 'src/new.ts',
                    sha: 'new-sha-2',
                    additions: 50,
                    deletions: 0,
                    changes: 50,
                    status: 'added',
                    patch: '@@ added',
                },
            ]);

            const persisted = await model
                .findOne({ _id: existingPR.uuid })
                .lean();
            expect(persisted).toBeTruthy();
            const files = (persisted as any).files;
            expect(files).toHaveLength(2);

            const keep = files.find((f: any) => f.path === 'src/keep.ts');
            expect(keep.id).toBe(existingFileId); // updated in place
            expect(keep.added).toBe(7);
            expect(keep.deleted).toBe(3);
            expect(keep.changes).toBe(10);
            expect(keep.patch).toBe('@@ updated');

            const created = files.find(
                (f: any) => f.path === 'src/new.ts',
            );
            expect(created.id).toBeTruthy();
            expect(created.added).toBe(50);
            expect(created.changes).toBe(50);
            expect(created.status).toBe('added');

            // Totals must match what the server-side aggregation
            // computes from the persisted files.
            expect((persisted as any).totalAdded).toBe(57);
            expect((persisted as any).totalDeleted).toBe(3);
            expect((persisted as any).totalChanges).toBe(60);
        });

        it('pushes new suggestions onto the existing file without rewriting earlier ones', async () => {
            const existingFileId = repository.newSubDocumentId();
            const previousSuggestionId = repository.newSubDocumentId();
            const existingPR = await seedExistingPR({
                number: 1002,
                files: [
                    {
                        id: existingFileId,
                        path: 'src/a.ts',
                        filename: 'a.ts',
                        previousName: '',
                        sha: 'sha',
                        status: 'modified',
                        suggestions: [
                            {
                                id: previousSuggestionId,
                                relevantFile: 'src/a.ts',
                                suggestionContent: 'old suggestion',
                                language: 'ts',
                                existingCode: '',
                                improvedCode: '',
                                oneSentenceSummary: 'old',
                                relevantLinesStart: 1,
                                relevantLinesEnd: 2,
                                label: 'l',
                                severity: 'low',
                                rankScore: 0,
                            },
                        ],
                        added: 5,
                        deleted: 5,
                        changes: 10,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    },
                ],
            });

            await callHandleExisting(
                existingPR,
                [
                    {
                        filename: 'src/a.ts',
                        sha: 'sha',
                        additions: 5,
                        deletions: 5,
                        changes: 10,
                        status: 'modified',
                    },
                ],
                [
                    {
                        relevantFile: 'src/a.ts',
                        suggestionContent: 'NEW suggestion',
                        language: 'ts',
                        existingCode: '',
                        improvedCode: '',
                        oneSentenceSummary: 'new',
                        relevantLinesStart: 10,
                        relevantLinesEnd: 11,
                        label: 'l',
                        severity: 'high',
                        rankScore: 0.9,
                    },
                ],
            );

            const persisted = await model
                .findOne({ _id: existingPR.uuid })
                .lean();
            const file = (persisted as any).files.find(
                (f: any) => f.path === 'src/a.ts',
            );
            expect(file.suggestions).toHaveLength(2);
            const ids = file.suggestions.map((s: any) => s.id);
            expect(ids).toContain(previousSuggestionId);
            const newOne = file.suggestions.find(
                (s: any) => s.suggestionContent === 'NEW suggestion',
            );
            expect(newOne).toBeDefined();
            expect(newOne.severity).toBe('high');
        });

        it('handles a medium PR (300 files) in a small number of bulkWrite chunks and persists every file', async () => {
            const existingFiles = Array.from({ length: 100 }, (_, i) => ({
                id: repository.newSubDocumentId(),
                path: `src/old-${i}.ts`,
                filename: `old-${i}.ts`,
                previousName: '',
                sha: `old-sha-${i}`,
                status: 'modified',
                suggestions: [],
                added: 1,
                deleted: 1,
                changes: 2,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }));
            const existingPR = await seedExistingPR({
                number: 1003,
                files: existingFiles,
            });

            const changedFiles = [
                ...existingFiles.map((f) => ({
                    filename: f.path,
                    sha: 'updated',
                    additions: 2,
                    deletions: 1,
                    changes: 3,
                    status: 'modified',
                })),
                ...Array.from({ length: 200 }, (_, i) => ({
                    filename: `src/new-${i}.ts`,
                    sha: `new-${i}`,
                    additions: 5,
                    deletions: 0,
                    changes: 5,
                    status: 'added',
                })),
            ];

            await callHandleExisting(existingPR, changedFiles);

            const persisted = await model
                .findOne({ _id: existingPR.uuid })
                .lean();
            expect((persisted as any).files).toHaveLength(300);
            // 100 existing updated to (2,1,3) + 200 new at (5,0,5)
            // = totalAdded = 100*2 + 200*5 = 1200
            //   totalDeleted = 100*1 + 0   = 100
            //   totalChanges = 100*3 + 200*5 = 1300
            expect((persisted as any).totalAdded).toBe(1200);
            expect((persisted as any).totalDeleted).toBe(100);
            expect((persisted as any).totalChanges).toBe(1300);
        });

        it('computeFileTotals returns the same numbers a hand-rolled aggregate would', async () => {
            const existingPR = await seedExistingPR({
                number: 1004,
                files: [
                    {
                        id: repository.newSubDocumentId(),
                        path: 'src/a.ts',
                        filename: 'a.ts',
                        previousName: '',
                        sha: 'x',
                        status: 'modified',
                        suggestions: [],
                        added: 11,
                        deleted: 22,
                        changes: 33,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    },
                    {
                        id: repository.newSubDocumentId(),
                        path: 'src/b.ts',
                        filename: 'b.ts',
                        previousName: '',
                        sha: 'y',
                        status: 'modified',
                        suggestions: [],
                        added: 4,
                        deleted: 0,
                        changes: 4,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    },
                ],
            });

            const totals = await repository.computeFileTotals(
                existingPR.uuid,
                TEST_ORG_ID,
            );
            expect(totals).toEqual({
                totalAdded: 15,
                totalDeleted: 22,
                totalChanges: 37,
            });
        });

        it('preserves pipeline-owned `reviewMode` and `codeReviewModelUsed` when the webhook payload does not carry them', async () => {
            // Pre-fix: the bulkWrite path's `$set` blindly included
            // `reviewMode: ''` and `codeReviewModelUsed: ''` on every
            // webhook save, clobbering values written by later
            // pipeline stages. The repo's `sanitizeCodeReviewConfigData`
            // — the same one `updateFile()` uses — is the canonical
            // place to drop those empty values, and the bulk path
            // now routes through it.
            const existingFileId = repository.newSubDocumentId();
            const existingPR = await seedExistingPR({
                number: 3001,
                files: [
                    {
                        id: existingFileId,
                        path: 'src/preserve.ts',
                        filename: 'preserve.ts',
                        previousName: '',
                        sha: 'sha',
                        status: 'modified',
                        suggestions: [],
                        added: 1,
                        deleted: 1,
                        changes: 2,
                        // Values written previously by the
                        // code-review pipeline; the webhook must
                        // never overwrite them.
                        reviewMode: 'light',
                        codeReviewModelUsed: {
                            generateSuggestions: 'model-a',
                            safeguard: 'model-b',
                        },
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    },
                ],
            });

            await callHandleExisting(existingPR, [
                {
                    filename: 'src/preserve.ts',
                    sha: 'new-sha',
                    additions: 7,
                    deletions: 0,
                    changes: 7,
                    status: 'modified',
                    patch: '@@ updated',
                    // intentionally no reviewMode / codeReviewModelUsed
                },
            ]);

            const persisted = await model
                .findOne({ _id: existingPR.uuid })
                .lean();
            const file = (persisted as any).files.find(
                (f: any) => f.path === 'src/preserve.ts',
            );
            // Metrics updated as expected …
            expect(file.added).toBe(7);
            expect(file.patch).toBe('@@ updated');
            // … but pipeline config untouched.
            expect(file.reviewMode).toBe('light');
            expect(file.codeReviewModelUsed).toEqual({
                generateSuggestions: 'model-a',
                safeguard: 'model-b',
            });
        });

        it('refuses to bulk-apply when organizationId is empty', async () => {
            const existingPR = await seedExistingPR({
                number: 2001,
                files: [
                    {
                        id: repository.newSubDocumentId(),
                        path: 'src/x.ts',
                        filename: 'x.ts',
                        previousName: '',
                        sha: 's',
                        status: 'modified',
                        suggestions: [],
                        added: 1,
                        deleted: 1,
                        changes: 2,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    },
                ],
            });

            await expect(
                repository.bulkApplyFileChanges(existingPR.uuid, '', [
                    {
                        kind: 'updateFile',
                        fileId: 'whatever',
                        data: { added: 99 },
                    },
                ]),
            ).rejects.toThrow(/organizationId/);

            await expect(
                repository.computeFileTotals(existingPR.uuid, ''),
            ).rejects.toThrow(/organizationId/);
        });

        it('cannot modify a PR that belongs to a different tenant — defense-in-depth', async () => {
            // Seed a real PR under TEST_ORG_ID.
            const existingFileId = repository.newSubDocumentId();
            const target = await seedExistingPR({
                number: 2002,
                files: [
                    {
                        id: existingFileId,
                        path: 'src/secret.ts',
                        filename: 'secret.ts',
                        previousName: '',
                        sha: 'orig',
                        status: 'modified',
                        suggestions: [],
                        added: 1,
                        deleted: 1,
                        changes: 2,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    },
                ],
            });

            // Now try to write to that PR's uuid as a different
            // tenant. With `_id` alone the write would succeed (it's
            // globally unique). The `organizationId` ANDed in is what
            // stops the wrong-tenant write.
            const wrongTenantResult =
                await repository.bulkApplyFileChanges(
                    target.uuid,
                    'some-other-tenant',
                    [
                        {
                            kind: 'updateFile',
                            fileId: existingFileId,
                            data: { added: 99999 },
                        },
                    ],
                );

            expect(wrongTenantResult.modified).toBe(0);
            expect(wrongTenantResult.errors).toEqual([]);

            // And the file was NOT touched.
            const persisted = await model
                .findOne({ _id: target.uuid })
                .lean();
            const file = (persisted as any).files.find(
                (f: any) => f.path === 'src/secret.ts',
            );
            expect(file.added).toBe(1); // unchanged

            // computeFileTotals from the wrong tenant must return 0s.
            const wrongTotals = await repository.computeFileTotals(
                target.uuid,
                'some-other-tenant',
            );
            expect(wrongTotals).toEqual({
                totalAdded: 0,
                totalDeleted: 0,
                totalChanges: 0,
            });
        });
    },
);
