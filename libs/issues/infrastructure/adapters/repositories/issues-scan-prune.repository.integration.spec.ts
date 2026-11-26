/**
 * Pruning the places of scan issues against a real MongoDB, in a throwaway
 * database: a place whose file left the branch goes, a place of a class the
 * scan read again without finding it goes, the rest stays, and another
 * organization's issues are not touched.
 */
import mongoose, { Connection, Model } from 'mongoose';

import { IssueStatus } from '@libs/core/infrastructure/config/types/general/issues.type';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { IssueSource } from '@libs/issues/domain/interfaces/issues.interface';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { LabelType } from '@libs/common/utils/codeManagement/labels';

import { IssuesRepository } from './issues.repository';
import { IssuesModel, IssuesSchema } from './schemas/issues.model';
import { resolveMongoTestGate } from '../../../../../test/integration/mongo-test-uri';

// Runs in CI (TEST_MONGODB_URI); skips locally without it.
const gate = resolveMongoTestGate('kodus_test', false);
const TEST_DB = 'issues_scan_prune_it';

(gate.shouldSkip ? describe.skip : describe)(
    'IssuesRepository: pruning places a scan shows are gone (real MongoDB)',
    () => {
        let connection: Connection;
        let model: Model<IssuesModel>;
        let issues: IssuesRepository;
        const repository = {
            id: 'repo-1',
            platform: PlatformType.GITHUB,
            host: 'github.com',
        };
        const place = (
            filePath: string,
            vulnerabilityClass: string,
            lastSeenScanId = 'scan-1',
        ) => ({
            fingerprint: `fp-${filePath}-${vulnerabilityClass}`,
            title: 't',
            filePath,
            startLine: 1,
            endLine: 1,
            severity: 'high',
            vulnerabilityClass,
            lastSeenScanId,
        });
        const issue = (
            _id: string,
            organizationId: string,
            occurrences: unknown[],
        ) => ({
            _id,
            organizationId,
            repository,
            source: IssueSource.SECURITY_SCAN,
            status: IssueStatus.OPEN,
            fingerprint: `fp-${_id}`,
            filePath: 'src/holder.ts',
            vulnerabilityClass: 'authz',
            lastSeenScanId: 'scan-2',
            lastSeenAt: '2026-11-26T00:00:00.000Z',
            occurrences,
        });
        const placesOf = async (_id: string) =>
            (
                ((await model.collection.findOne({ _id } as any)) as any)
                    .occurrences ?? []
            ).map((o: any) => `${o.filePath}#${o.vulnerabilityClass}`);

        beforeAll(async () => {
            connection = await mongoose
                .createConnection(gate.mongoUri, {
                    dbName: TEST_DB,
                    serverSelectionTimeoutMS: 5000,
                })
                .asPromise();
            await connection.dropDatabase();
            model = connection.model<IssuesModel>(
                IssuesModel.name,
                IssuesSchema,
            );
            issues = new IssuesRepository(model as any);
        }, 30_000);

        beforeEach(async () => {
            await model.deleteMany({});
        });

        afterAll(async () => {
            await connection?.dropDatabase();
            await connection?.close();
        });

        it('drops gone and unseen places only, and only in its own organization', async () => {
            await model.collection.insertMany([
                issue('i-1', 'org-1', [
                    place('src/gone.ts', 'authz'),
                    place('src/kept.ts', 'authz'),
                    place('src/kept.ts', 'injection'),
                    place('src/seen.ts', 'authz', 'scan-2'),
                ]),
                issue('i-2', 'org-2', [
                    place('src/gone.ts', 'authz'),
                    place('src/kept.ts', 'authz'),
                ]),
            ] as any[]);

            await issues.resolveUnseenScanFindings({
                organizationId: 'org-1',
                repositoryPlatform: PlatformType.GITHUB,
                repositoryHost: 'github.com',
                repositoryId: 'repo-1',
                scanId: 'scan-2',
                scanStartedAt: '2026-11-25T00:00:00.000Z',
                trackedFiles: ['src/holder.ts', 'src/kept.ts', 'src/seen.ts'],
                examined: [
                    {
                        vulnerabilityClass: 'authz',
                        filePaths: ['src/kept.ts', 'src/seen.ts'],
                    },
                ],
            } as any);

            // The gone file's place and the authz place read again without
            // being found leave; the injection place (not read) and the place
            // this scan saw again stay.
            expect(await placesOf('i-1')).toEqual([
                'src/kept.ts#injection',
                'src/seen.ts#authz',
            ]);
            expect(await placesOf('i-2')).toEqual([
                'src/gone.ts#authz',
                'src/kept.ts#authz',
            ]);
        });

        it('sets the severity back to the worst of its own and the places it keeps', async () => {
            await model.collection.insertMany([
                {
                    ...issue('h-1', 'org-1', [
                        {
                            ...place('src/fixed.ts', 'authz'),
                            severity: 'critical',
                        },
                        {
                            ...place('src/kept.ts', 'injection'),
                            severity: 'high',
                        },
                    ]),
                    severity: 'critical',
                    ownSeverity: 'medium',
                },
                {
                    ...issue('h-2', 'org-1', [
                        {
                            ...place('src/fixed.ts', 'authz'),
                            severity: 'critical',
                        },
                    ]),
                    severity: 'critical',
                    ownSeverity: 'medium',
                },
                // Stored before its own severity was kept: left as it is.
                {
                    ...issue('h-3', 'org-1', [
                        {
                            ...place('src/fixed.ts', 'authz'),
                            severity: 'critical',
                        },
                    ]),
                    severity: 'critical',
                },
                // Nothing of it pruned: not rewritten.
                {
                    ...issue('h-4', 'org-1', [
                        {
                            ...place('src/other.ts', 'authz'),
                            severity: 'critical',
                        },
                    ]),
                    severity: 'critical',
                    ownSeverity: 'low',
                },
            ] as any[]);

            await issues.resolveUnseenScanFindings({
                organizationId: 'org-1',
                repositoryPlatform: PlatformType.GITHUB,
                repositoryHost: 'github.com',
                repositoryId: 'repo-1',
                scanId: 'scan-3',
                scanStartedAt: '2026-11-25T00:00:00.000Z',
                trackedFiles: [
                    'src/holder.ts',
                    'src/fixed.ts',
                    'src/kept.ts',
                    'src/other.ts',
                ],
                examined: [
                    {
                        vulnerabilityClass: 'authz',
                        filePaths: ['src/fixed.ts'],
                    },
                ],
            } as any);

            const severityOf = async (_id: string) =>
                ((await model.collection.findOne({ _id } as any)) as any)
                    .severity;
            expect(await placesOf('h-1')).toEqual(['src/kept.ts#injection']);
            expect(await severityOf('h-1')).toBe('high');
            expect(await placesOf('h-2')).toEqual([]);
            expect(await severityOf('h-2')).toBe('medium');
            expect(await placesOf('h-3')).toEqual([]);
            expect(await severityOf('h-3')).toBe('critical');
            expect(await severityOf('h-4')).toBe('critical');
        });

        const scan = (
            scanId: string,
            scanStartedAt: string,
            examined: unknown[],
        ) =>
            issues.resolveUnseenScanFindings({
                organizationId: 'org-1',
                repositoryPlatform: PlatformType.GITHUB,
                repositoryHost: 'github.com',
                repositoryId: 'repo-1',
                scanId,
                scanStartedAt,
                trackedFiles: ['src/holder.ts', 'src/a.ts', 'src/b.ts'],
                examined,
            } as any);

        it('keeps a place a scan that overlapped this one saw after it started', async () => {
            await model.collection.insertOne(
                issue('i-1', 'org-1', [
                    // Seen by a newer scan while this one ran.
                    {
                        ...place('src/a.ts', 'authz', 'scan-9'),
                        lastSeenAt: '2026-11-25T12:00:00.000Z',
                    },
                    {
                        ...place('src/b.ts', 'authz', 'scan-1'),
                        lastSeenAt: '2026-11-20T00:00:00.000Z',
                    },
                ]) as any,
            );

            await scan('scan-2', '2026-11-25T00:00:00.000Z', [
                {
                    vulnerabilityClass: 'authz',
                    filePaths: ['src/a.ts', 'src/b.ts'],
                },
            ]);

            expect(await placesOf('i-1')).toEqual(['src/a.ts#authz']);
        });

        it('resolves an issue missed twice only once it holds no place', async () => {
            const missed = {
                lastSeenAt: '2026-11-20T00:00:00.000Z',
                consecutiveScanMisses: 1,
            };
            await model.collection.insertMany([
                // Its own place missed again, another place of it unread.
                {
                    ...issue('i-1', 'org-1', [place('src/a.ts', 'injection')]),
                    ...missed,
                },
                // Its own place missed again, and its only place gone too.
                {
                    ...issue('i-2', 'org-1', [place('src/a.ts', 'authz')]),
                    ...missed,
                },
            ] as any[]);

            await scan('scan-3', '2026-11-25T00:00:00.000Z', [
                {
                    vulnerabilityClass: 'authz',
                    filePaths: ['src/holder.ts', 'src/a.ts'],
                },
            ]);

            const statusOf = async (_id: string) =>
                ((await model.collection.findOne({ _id } as any)) as any)
                    .status;
            expect(await statusOf('i-1')).toBe(IssueStatus.OPEN);
            expect(await statusOf('i-2')).toBe(IssueStatus.RESOLVED);
        });

        it('refreshes an issue that holds places when its own finding is seen again', async () => {
            // An id as the schema stores it: the sighting reads it back.
            const _id = new mongoose.Types.ObjectId();
            await model.collection.insertOne({
                ...issue('i-1', 'org-1', [
                    { ...place('src/a.ts', 'authz'), severity: 'critical' },
                ]),
                fingerprint: 'fp-own',
                severity: 'critical',
                ownSeverity: 'medium',
                lastSeenScanId: 'scan-1',
                _id,
            } as any);

            const { outcome } = await issues.upsertScanFinding({
                title: 'Order lookup skips the owner check',
                description: 'Any signed-in user can read any order by id.',
                filePath: 'src/holder.ts',
                language: 'typescript',
                label: LabelType.SECURITY,
                severity: SeverityLevel.LOW,
                repository: {
                    ...repository,
                    name: 'shop',
                    full_name: 'acme/shop',
                },
                organizationId: 'org-1',
                fingerprint: 'fp-own',
                vulnerabilityClass: 'authz',
                startLine: 1,
                endLine: 2,
                lastSeenScanId: 'scan-2',
            } as any);

            const stored = (await model.collection.findOne({ _id })) as any;
            expect(outcome).toBe('still_open');
            expect(stored).toMatchObject({
                lastSeenScanId: 'scan-2',
                ownSeverity: 'low',
                severity: 'critical',
            });
        });

        it('refreshes an issue that never held a place', async () => {
            const _id = new mongoose.Types.ObjectId();
            const { occurrences: _none, ...plain } = issue('i-1', 'org-1', []);
            await model.collection.insertOne({
                ...plain,
                fingerprint: 'fp-own',
                lastSeenScanId: 'scan-1',
                _id,
            } as any);

            const { outcome } = await issues.upsertScanFinding({
                title: 'Order lookup skips the owner check',
                description: 'Any signed-in user can read any order by id.',
                filePath: 'src/holder.ts',
                language: 'typescript',
                label: LabelType.SECURITY,
                severity: SeverityLevel.HIGH,
                repository: {
                    ...repository,
                    name: 'shop',
                    full_name: 'acme/shop',
                },
                organizationId: 'org-1',
                fingerprint: 'fp-own',
                vulnerabilityClass: 'authz',
                startLine: 1,
                endLine: 2,
                lastSeenScanId: 'scan-2',
            } as any);

            expect(outcome).toBe('still_open');
            expect(await model.collection.findOne({ _id })).toMatchObject({
                lastSeenScanId: 'scan-2',
                ownSeverity: 'high',
                severity: 'high',
            });
        });

        it('a holder stored before its own severity was kept goes back to it once the folded place leaves', async () => {
            const _id = new mongoose.Types.ObjectId();
            const { occurrences: _none, ...legacy } = issue('h-1', 'org-1', []);
            await model.collection.insertOne({
                ...legacy,
                _id,
                fingerprint: 'fp-holder',
                severity: 'medium',
                lastSeenAt: '2026-11-20T00:00:00.000Z',
            } as any);

            await issues.addScanFindingOccurrence({
                organizationId: 'org-1',
                repositoryPlatform: PlatformType.GITHUB,
                repositoryHost: 'github.com',
                repositoryId: 'repo-1',
                holderFingerprint: 'fp-holder',
                occurrence: {
                    ...place('src/a.ts', 'authz'),
                    severity: 'critical',
                },
                scanId: 'scan-2',
            } as any);
            expect(await model.collection.findOne({ _id })).toMatchObject({
                severity: 'critical',
                ownSeverity: 'medium',
            });

            // A later scan reads the place's class again without finding it.
            await scan('scan-3', '2099-01-01T00:00:00.000Z', [
                { vulnerabilityClass: 'authz', filePaths: ['src/a.ts'] },
            ]);
            const after = (await model.collection.findOne({ _id })) as any;
            expect(after.occurrences).toEqual([]);
            expect(after.severity).toBe('medium');
        });

        it('keeps a place the scan found again through the issue that holds it', async () => {
            await model.collection.insertMany([
                issue('i-1', 'org-1', [
                    { ...place('src/a.ts', 'authz'), severity: 'critical' },
                    place('src/b.ts', 'authz'),
                ]),
                // Another organization's place under the same identity.
                issue('i-2', 'org-2', [place('src/a.ts', 'authz')]),
            ] as any[]);

            // The dedup dropped the fresh finding at src/a.ts as a repeat of
            // i-1, and reported its own identity found again.
            await issues.markScanFindingsSeen({
                organizationId: 'org-1',
                repositoryPlatform: PlatformType.GITHUB,
                repositoryHost: 'github.com',
                repositoryId: 'repo-1',
                fingerprints: ['fp-src/a.ts-authz'],
                scanId: 'scan-3',
                foundAgain: true,
            });
            await scan('scan-3', '2026-11-25T00:00:00.000Z', [
                {
                    vulnerabilityClass: 'authz',
                    filePaths: ['src/a.ts', 'src/b.ts'],
                },
            ]);

            expect(await placesOf('i-1')).toEqual(['src/a.ts#authz']);
            const other = (await model.collection.findOne({
                _id: 'i-2',
            } as any)) as any;
            expect(other.occurrences[0].lastSeenScanId).toBe('scan-1');
        });
    },
);
