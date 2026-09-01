import { Types } from 'mongoose';

import { PullRequestIngestionService } from './pull-request-ingestion.service';

/**
 * Mutation-killing unit tests for the deterministic logic in
 * PullRequestIngestionService: `writeOnePR` (parameter mapping, guard
 * clauses, default fallbacks, child fan-out and counting) and
 * `toObjectIdOrString` (ObjectId coercion vs raw-string fallback).
 *
 * The service has a heavy NestJS constructor (a TypeORM DataSource and a
 * Mongoose Model); neither of these methods touches those deps, so the
 * instance is built with inert `{} as any` stubs and the private methods
 * are reached via `(instance as any)`.
 */
describe('PullRequestIngestionService (deterministic logic)', () => {
    let service: PullRequestIngestionService;

    beforeEach(() => {
        service = new PullRequestIngestionService(
            {} as any, // analyticsDs (unused by the methods under test)
            {} as any, // pullRequestsModel (unused by the methods under test)
        );
    });

    /**
     * A fake TypeORM EntityManager whose `query` records every call so the
     * test can assert the exact SQL family, parameter order and values.
     */
    function makeManager() {
        const query = jest.fn().mockResolvedValue(undefined);
        return { query } as any;
    }

    const writeOnePR = (pr: unknown, manager: any) =>
        (service as any).writeOnePR(manager, pr);

    const toObjectIdOrString = (id: string) =>
        (service as any).toObjectIdOrString(id);

    describe('toObjectIdOrString', () => {
        it('coerces a valid 24-hex ObjectId string to a Types.ObjectId preserving the value', () => {
            const hex = '507f1f77bcf86cd799439011';
            const result = toObjectIdOrString(hex);

            expect(result).toBeInstanceOf(Types.ObjectId);
            expect(String(result)).toBe(hex);
        });

        it('returns the raw string unchanged (same reference) when it is not a valid ObjectId', () => {
            const raw = 'not-a-valid-object-id';
            const result = toObjectIdOrString(raw);

            // Falls through the `isValid` guard -> returns input identity.
            expect(result).toBe(raw);
            expect(result).not.toBeInstanceOf(Types.ObjectId);
        });

        it('does not wrap an empty string (invalid) — returns it verbatim', () => {
            const result = toObjectIdOrString('');
            expect(result).toBe('');
            expect(result).not.toBeInstanceOf(Types.ObjectId);
        });
    });

    describe('writeOnePR — main pull_requests_opt insert', () => {
        it('maps every column, in order, from a fully-populated PR', async () => {
            const pr = {
                _id: 'PR_ABC',
                organizationId: 'org-1',
                repository: { fullName: 'acme/widgets', id: 'repo-9' },
                status: 'opened',
                user: { id: 'user-7', username: 'alice' },
                totalChanges: 42,
                createdAt: '2026-01-01T00:00:00.000Z',
                openedAt: '2026-01-02T00:00:00.000Z',
                closedAt: '2026-01-03T00:00:00.000Z',
                updatedAt: '2026-01-04T00:00:00.000Z',
                number: 7,
                files: [],
                commits: [],
            };
            const manager = makeManager();

            const result = await writeOnePR(pr, manager);

            expect(result).toEqual({ suggestions: 0, commits: 0 });

            const [sql, params] = manager.query.mock.calls[0];
            expect(sql).toContain('"analytics"."pull_requests_opt"');
            expect(params).toEqual([
                'PR_ABC', // $1  _id (String(_id))
                'org-1', // $2  organizationId
                'acme/widgets', // $3  repo_full_name
                'repo-9', // $4  repositoryId
                'opened', // $5  status
                'user-7', // $6  authorId
                'alice', // $7  author_username
                42, // $8  totalChanges
                '2026-01-01T00:00:00.000Z', // $9  createdAt (raw)
                '2026-01-02T00:00:00.000Z', // $10 openedAt (raw)
                '2026-01-03T00:00:00.000Z', // $11 closedAt (raw)
                new Date('2026-01-01T00:00:00.000Z'), // $12 parsed_created_at
                new Date('2026-01-02T00:00:00.000Z'), // $13 parsed_opened_at
                new Date('2026-01-03T00:00:00.000Z'), // $14 parsed_closed_at
                '[]', // $15 files jsonb
                '[]', // $16 commits jsonb
                new Date('2026-01-04T00:00:00.000Z'), // $17 source_updated_at
                7, // $18 pr_number
            ]);
        });

        it('applies null fallbacks for every optional column on a minimal PR', async () => {
            const pr = { _id: 'PR_MIN' };
            const manager = makeManager();

            const result = await writeOnePR(pr, manager);

            expect(result).toEqual({ suggestions: 0, commits: 0 });

            const params = manager.query.mock.calls[0][1];
            expect(params).toEqual([
                'PR_MIN', // _id
                undefined, // organizationId (not defaulted — passed through)
                null, // repo_full_name
                null, // repositoryId
                null, // status
                null, // authorId
                null, // author_username
                null, // totalChanges
                null, // createdAt raw
                null, // openedAt raw
                null, // closedAt raw
                null, // parsed_created_at
                null, // parsed_opened_at
                null, // parsed_closed_at
                '[]', // files -> JSON.stringify([])
                '[]', // commits -> JSON.stringify([])
                null, // source_updated_at
                null, // pr_number (undefined is not a number)
            ]);
        });

        it('coerces a non-string _id via String() for prId', async () => {
            const pr = { _id: 12345, files: [], commits: [] };
            const manager = makeManager();

            await writeOnePR(pr, manager);

            expect(manager.query.mock.calls[0][1][0]).toBe('12345');
        });

        it('keeps totalChanges === 0 (nullish coalescing, not truthiness)', async () => {
            const pr = { _id: 'z', totalChanges: 0, files: [], commits: [] };
            const manager = makeManager();

            await writeOnePR(pr, manager);

            // A `||` mutant would turn 0 into null here.
            expect(manager.query.mock.calls[0][1][7]).toBe(0);
        });

        it('keeps pr_number === 0 (0 is a number, not null)', async () => {
            const pr = { _id: 'z', number: 0, files: [], commits: [] };
            const manager = makeManager();

            await writeOnePR(pr, manager);

            expect(manager.query.mock.calls[0][1][17]).toBe(0);
        });

        it('passes null pr_number when number is not numeric', async () => {
            const pr = { _id: 'z', number: '7', files: [], commits: [] };
            const manager = makeManager();

            await writeOnePR(pr, manager);

            expect(manager.query.mock.calls[0][1][17]).toBeNull();
        });

        it('serialises files/commits arrays as JSON into the jsonb columns', async () => {
            const pr = {
                _id: 'z',
                files: [{ path: 'x.ts', suggestions: [] }],
                commits: [{ sha: 'abc' }],
            };
            const manager = makeManager();

            await writeOnePR(pr, manager);

            const params = manager.query.mock.calls[0][1];
            expect(params[14]).toBe(
                JSON.stringify([{ path: 'x.ts', suggestions: [] }]),
            );
            expect(params[15]).toBe(JSON.stringify([{ sha: 'abc' }]));
        });
    });

    describe('writeOnePR — child wipe (DELETE) statements', () => {
        it('deletes existing suggestions and commits for the PR id before re-insert', async () => {
            const pr = { _id: 'PR_DEL', files: [], commits: [] };
            const manager = makeManager();

            await writeOnePR(pr, manager);

            const [suggSql, suggParams] = manager.query.mock.calls[1];
            expect(suggSql).toContain(
                'DELETE FROM "analytics"."suggestions_mv"',
            );
            expect(suggSql).toContain('"pullRequestId" = $1');
            expect(suggParams).toEqual(['PR_DEL']);

            const [commitSql, commitParams] = manager.query.mock.calls[2];
            expect(commitSql).toContain(
                'DELETE FROM "analytics"."commits_view"',
            );
            expect(commitSql).toContain('"pull_request_id" = $1');
            expect(commitParams).toEqual(['PR_DEL']);
        });
    });

    describe('writeOnePR — suggestion fan-out', () => {
        it('skips id-less suggestions and only counts/inserts delivered ones', async () => {
            const pr = {
                _id: 'PR_S',
                organizationId: 'org-1',
                repository: { id: 'repo-1' },
                files: [
                    {
                        path: 'a.ts',
                        suggestions: [
                            { id: undefined, label: 'draft' }, // dropped
                            { id: 's-1', label: 'kept' }, // inserted
                        ],
                    },
                ],
                commits: [],
            };
            const manager = makeManager();

            const result = await writeOnePR(pr, manager);

            expect(result.suggestions).toBe(1);
            // calls: [0]=insertPR, [1]=delSugg, [2]=delCommits, [3]=insert kept
            const inserts = manager.query.mock.calls.filter(([sql]) =>
                sql.includes('INSERT INTO "analytics"."suggestions_mv"'),
            );
            expect(inserts).toHaveLength(1);
            expect(inserts[0][1][0]).toBe('s-1');
        });

        it('maps all suggestion columns and defaults, and uses file.path over file.filename', async () => {
            const suggestion = {
                id: 's-42',
                label: 'security',
                severity: 'high',
                deliveryStatus: 'sent',
                implementationStatus: 'pending',
                createdAt: '2026-05-05T10:00:00.000Z',
                brokenKodyRulesIds: ['r1', 'r2'],
            };
            const pr = {
                _id: 'PR_MAP',
                organizationId: 'org-9',
                repository: { id: 'repo-3' },
                files: [
                    {
                        path: 'src/a.ts',
                        filename: 'ignored.ts',
                        suggestions: [suggestion],
                    },
                ],
                commits: [],
            };
            const manager = makeManager();

            await writeOnePR(pr, manager);

            const insert = manager.query.mock.calls.find(([sql]) =>
                sql.includes('INSERT INTO "analytics"."suggestions_mv"'),
            );
            expect(insert[1]).toEqual([
                's-42', // suggestion_id
                'org-9', // organizationId
                'PR_MAP', // pullRequestId
                'repo-3', // repositoryId
                'src/a.ts', // filePath (path wins over filename)
                'security', // label
                'high', // severity
                'sent', // deliveryStatus
                'pending', // implementationStatus (string branch)
                new Date('2026-05-05T10:00:00.000Z'), // createdAt (parsed)
                ['r1', 'r2'], // brokenKodyRulesIds (array kept)
                JSON.stringify(suggestion), // raw
            ]);
        });

        it('falls back to file.filename when file.path is absent', async () => {
            const pr = {
                _id: 'PR_F',
                files: [
                    {
                        filename: 'only-filename.ts',
                        suggestions: [{ id: 's' }],
                    },
                ],
                commits: [],
            };
            const manager = makeManager();

            await writeOnePR(pr, manager);

            const insert = manager.query.mock.calls.find(([sql]) =>
                sql.includes('INSERT INTO "analytics"."suggestions_mv"'),
            );
            expect(insert[1][4]).toBe('only-filename.ts');
        });

        it('extracts .default from an object implementationStatus', async () => {
            const pr = {
                _id: 'PR_I',
                files: [
                    {
                        path: 'a.ts',
                        suggestions: [
                            {
                                id: 's',
                                implementationStatus: { default: 'done' },
                            },
                        ],
                    },
                ],
                commits: [],
            };
            const manager = makeManager();

            await writeOnePR(pr, manager);

            const insert = manager.query.mock.calls.find(([sql]) =>
                sql.includes('INSERT INTO "analytics"."suggestions_mv"'),
            );
            expect(insert[1][8]).toBe('done');
        });

        it('yields null implementationStatus for an object without a default', async () => {
            const pr = {
                _id: 'PR_I2',
                files: [
                    {
                        path: 'a.ts',
                        suggestions: [{ id: 's', implementationStatus: {} }],
                    },
                ],
                commits: [],
            };
            const manager = makeManager();

            await writeOnePR(pr, manager);

            const insert = manager.query.mock.calls.find(([sql]) =>
                sql.includes('INSERT INTO "analytics"."suggestions_mv"'),
            );
            expect(insert[1][8]).toBeNull();
        });

        it('yields null brokenKodyRulesIds when the field is not an array', async () => {
            const pr = {
                _id: 'PR_B',
                files: [
                    {
                        path: 'a.ts',
                        suggestions: [{ id: 's', brokenKodyRulesIds: 'oops' }],
                    },
                ],
                commits: [],
            };
            const manager = makeManager();

            await writeOnePR(pr, manager);

            const insert = manager.query.mock.calls.find(([sql]) =>
                sql.includes('INSERT INTO "analytics"."suggestions_mv"'),
            );
            expect(insert[1][10]).toBeNull();
        });

        it('counts suggestions across multiple files', async () => {
            const pr = {
                _id: 'PR_MULTI',
                files: [
                    { path: 'a.ts', suggestions: [{ id: 's1' }, { id: 's2' }] },
                    { path: 'b.ts', suggestions: [{ id: 's3' }] },
                ],
                commits: [],
            };
            const manager = makeManager();

            const result = await writeOnePR(pr, manager);

            expect(result.suggestions).toBe(3);
        });
    });

    describe('writeOnePR — commit fan-out', () => {
        it('resolves the hash preferring sha, then hash, then commit_hash', async () => {
            const pr = {
                _id: 'PR_C',
                organizationId: 'org-c',
                commits: [
                    { sha: 'SHA', hash: 'HASH', commit_hash: 'CH' },
                    { hash: 'HASH2', commit_hash: 'CH2' },
                    { commit_hash: 'CH3' },
                ],
                files: [],
            };
            const manager = makeManager();

            const result = await writeOnePR(pr, manager);

            expect(result.commits).toBe(3);
            const inserts = manager.query.mock.calls.filter(([sql]) =>
                sql.includes('INSERT INTO "analytics"."commits_view"'),
            );
            expect(inserts.map((c) => c[1][1])).toEqual([
                'SHA',
                'HASH2',
                'CH3',
            ]);
        });

        it('skips commits with no hash and does not count them', async () => {
            const pr = {
                _id: 'PR_NH',
                commits: [{ author: { name: 'nobody' } }, { sha: 'ok' }],
                files: [],
            };
            const manager = makeManager();

            const result = await writeOnePR(pr, manager);

            expect(result.commits).toBe(1);
            const inserts = manager.query.mock.calls.filter(([sql]) =>
                sql.includes('INSERT INTO "analytics"."commits_view"'),
            );
            expect(inserts).toHaveLength(1);
            expect(inserts[0][1][1]).toBe('ok');
        });

        it('maps every commit column with commit_timestamp winning for both ts and tsRaw', async () => {
            const commit = {
                sha: 'deadbeef',
                commit_timestamp: '2026-07-01T12:00:00.000Z',
                author: {
                    username: 'bob',
                    name: 'Bob Smith',
                    date: '2020-01-01',
                },
            };
            const pr = {
                _id: 'PR_CT',
                organizationId: 'org-ct',
                commits: [commit],
                files: [],
            };
            const manager = makeManager();

            await writeOnePR(pr, manager);

            const insert = manager.query.mock.calls.find(([sql]) =>
                sql.includes('INSERT INTO "analytics"."commits_view"'),
            );
            expect(insert[1]).toEqual([
                'PR_CT', // pull_request_id
                'deadbeef', // commit_hash
                'org-ct', // organizationId
                new Date('2026-07-01T12:00:00.000Z'), // commit_timestamp (parsed)
                '2026-07-01T12:00:00.000Z', // commit_timestamp_raw
                'bob', // author_username (username wins over name)
                JSON.stringify(commit), // raw
            ]);
        });

        it('uses author.name when author.username is absent', async () => {
            const pr = {
                _id: 'PR_AN',
                commits: [{ sha: 's', author: { name: 'Only Name' } }],
                files: [],
            };
            const manager = makeManager();

            await writeOnePR(pr, manager);

            const insert = manager.query.mock.calls.find(([sql]) =>
                sql.includes('INSERT INTO "analytics"."commits_view"'),
            );
            expect(insert[1][5]).toBe('Only Name');
        });

        it('parses ts from createdAt fallback but leaves tsRaw null (createdAt is not in the raw chain)', async () => {
            // ts chain: commit_timestamp ?? createdAt ?? created_at ?? author.date
            // tsRaw chain: commit_timestamp | created_at | author.date  (NO createdAt)
            const pr = {
                _id: 'PR_TS',
                commits: [{ sha: 's', createdAt: '2026-03-03T00:00:00.000Z' }],
                files: [],
            };
            const manager = makeManager();

            await writeOnePR(pr, manager);

            const insert = manager.query.mock.calls.find(([sql]) =>
                sql.includes('INSERT INTO "analytics"."commits_view"'),
            );
            expect(insert[1][3]).toEqual(new Date('2026-03-03T00:00:00.000Z')); // ts
            expect(insert[1][4]).toBeNull(); // tsRaw
        });

        it('resolves tsRaw to created_at when commit_timestamp is absent', async () => {
            const pr = {
                _id: 'PR_TS2',
                commits: [{ sha: 's', created_at: '2026-04-04T00:00:00.000Z' }],
                files: [],
            };
            const manager = makeManager();

            await writeOnePR(pr, manager);

            const insert = manager.query.mock.calls.find(([sql]) =>
                sql.includes('INSERT INTO "analytics"."commits_view"'),
            );
            expect(insert[1][3]).toEqual(new Date('2026-04-04T00:00:00.000Z'));
            expect(insert[1][4]).toBe('2026-04-04T00:00:00.000Z');
        });

        it('resolves tsRaw to author.date when only author.date is a string', async () => {
            const pr = {
                _id: 'PR_TS3',
                commits: [
                    { sha: 's', author: { date: '2026-06-06T00:00:00.000Z' } },
                ],
                files: [],
            };
            const manager = makeManager();

            await writeOnePR(pr, manager);

            const insert = manager.query.mock.calls.find(([sql]) =>
                sql.includes('INSERT INTO "analytics"."commits_view"'),
            );
            expect(insert[1][3]).toEqual(new Date('2026-06-06T00:00:00.000Z'));
            expect(insert[1][4]).toBe('2026-06-06T00:00:00.000Z');
        });

        it('leaves ts and tsRaw null when no timestamp field is present', async () => {
            const pr = { _id: 'PR_TS4', commits: [{ sha: 's' }], files: [] };
            const manager = makeManager();

            await writeOnePR(pr, manager);

            const insert = manager.query.mock.calls.find(([sql]) =>
                sql.includes('INSERT INTO "analytics"."commits_view"'),
            );
            expect(insert[1][3]).toBeNull();
            expect(insert[1][4]).toBeNull();
        });

        it('yields null author_username when author is missing entirely', async () => {
            const pr = { _id: 'PR_NA', commits: [{ sha: 's' }], files: [] };
            const manager = makeManager();

            await writeOnePR(pr, manager);

            const insert = manager.query.mock.calls.find(([sql]) =>
                sql.includes('INSERT INTO "analytics"."commits_view"'),
            );
            expect(insert[1][5]).toBeNull();
        });
    });

    describe('writeOnePR — combined counting return value', () => {
        it('returns exact suggestion and commit counts together', async () => {
            const pr = {
                _id: 'PR_ALL',
                files: [
                    { path: 'a.ts', suggestions: [{ id: 's1' }, { id: null }] },
                ],
                commits: [{ sha: 'c1' }, { hash: 'c2' }, { nope: true }],
            };
            const manager = makeManager();

            const result = await writeOnePR(pr, manager);

            expect(result).toEqual({ suggestions: 1, commits: 2 });
        });
    });
});
