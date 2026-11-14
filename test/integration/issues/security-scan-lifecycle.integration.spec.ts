import { createConnection, Connection, Model } from 'mongoose';
import { IssuesRepository } from '@libs/issues/infrastructure/adapters/repositories/issues.repository';
import {
    IssuesModel,
    IssuesSchema,
} from '@libs/issues/infrastructure/adapters/repositories/schemas/issues.model';
import { IssueSource } from '@libs/issues/domain/interfaces/issues.interface';
import { IssueStatus } from '@libs/core/infrastructure/config/types/general/issues.type';
import { PlatformType } from '@libs/core/domain/enums';
import { resolveMongoTestGate } from '../mongo-test-uri';

const { shouldSkip, mongoUri } = resolveMongoTestGate('kodus_test', false);

(shouldSkip ? describe.skip : describe)(
    'scan finding lifecycle on real Mongo',
    () => {
        let connection: Connection;
        let model: Model<IssuesModel>;
        let repository: IssuesRepository;
        const finding: any = {
            organizationId: 'scan-lifecycle-test',
            repository: {
                id: '123',
                platform: PlatformType.GITHUB,
                host: 'github.com',
                name: 'fixture',
            },
            fingerprint: 'same-function-and-cwe',
            filePath: 'src/routes.ts',
            symbol: 'route',
            vulnerabilityClass: 'injection',
            cwe: 'CWE-89',
            title: 'SQL injection',
            description: 'User input reaches SQL.',
            severity: 'high',
            label: 'security',
            language: 'typescript',
            startLine: 10,
            endLine: 12,
            lastSeenScanId: 'scan-1',
            source: IssueSource.SECURITY_SCAN,
        };
        const missed = (scanId: string) =>
            repository.resolveUnseenScanFindings({
                organizationId: finding.organizationId,
                repositoryPlatform: PlatformType.GITHUB,
                repositoryHost: 'github.com',
                repositoryId: '123',
                scanId,
                examined: [
                    {
                        vulnerabilityClass: 'injection',
                        filePaths: ['src/routes.ts'],
                    },
                ],
                scanStartedAt: new Date(Date.now() + 60_000).toISOString(),
            });
        beforeAll(async () => {
            connection = await createConnection(mongoUri, {
                dbName: 'kodus_test',
            }).asPromise();
            model = connection.model(
                'ScanLifecycle',
                IssuesSchema.clone(),
                `scan_lifecycle_${process.pid}_${Date.now()}`,
            );
            await model.init();
            repository = new IssuesRepository(model as any);
        });
        afterAll(async () => {
            await model?.collection.drop();
            await connection?.close();
        });
        it('keeps one unchanged issue, requires two distinct misses, and resets misses on a sighting', async () => {
            expect((await repository.upsertScanFinding(finding)).outcome).toBe(
                'created',
            );
            expect(
                (
                    await repository.upsertScanFinding({
                        ...finding,
                        lastSeenScanId: 'scan-2',
                    })
                ).outcome,
            ).toBe('still_open');
            expect(await model.countDocuments()).toBe(1);
            expect(await missed('scan-2')).toBe(0);
            expect(await missed('scan-3')).toBe(0);
            expect(await missed('scan-3')).toBe(0); // redelivery is not another scan
            expect(await model.findOne().lean()).toMatchObject({
                status: IssueStatus.OPEN,
                consecutiveScanMisses: 1,
            });
            expect(await missed('scan-4')).toBe(1);
            expect(await model.findOne().lean()).toMatchObject({
                status: IssueStatus.RESOLVED,
                consecutiveScanMisses: 2,
            });
            expect(
                (
                    await repository.upsertScanFinding({
                        ...finding,
                        lastSeenScanId: 'scan-5',
                    })
                ).outcome,
            ).toBe('reopened');
            expect(await missed('scan-6')).toBe(0);
            await repository.markScanFindingsSeen({
                organizationId: finding.organizationId,
                repositoryPlatform: PlatformType.GITHUB,
                repositoryHost: 'github.com',
                repositoryId: '123',
                scanId: 'scan-7',
                fingerprints: [finding.fingerprint],
                foundAgain: true,
            });
            expect(await model.findOne().lean()).toMatchObject({
                status: IssueStatus.OPEN,
                consecutiveScanMisses: 0,
            });
            expect(await missed('scan-8')).toBe(0);
            expect(await model.countDocuments()).toBe(1);
        });
    },
);
