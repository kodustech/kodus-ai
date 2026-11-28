/**
 * The schedule upsert against a real MongoDB, in a throwaway database: a save
 * that says nothing about `enabled` keeps a paused schedule paused, and every
 * save touches only its own organization and repository.
 */
import mongoose, { Connection, Model } from 'mongoose';

import { ConflictException } from '@nestjs/common';

import { SecurityScanSchedulesUseCase } from '../application/security-scan-schedules.use-case';
import { SecurityScanScheduleRepository } from './security-scan-schedule.repository';
import {
    SecurityScanScheduleModel,
    SecurityScanScheduleSchema,
} from './security-scan-schedule.model';
import { resolveMongoTestGate } from '../../../test/integration/mongo-test-uri';

// Runs in CI (TEST_MONGODB_URI); skips locally without it.
const gate = resolveMongoTestGate('kodus_test', false);
const TEST_DB = 'security_scan_schedules_it';

(gate.shouldSkip ? describe.skip : describe)(
    'SecurityScanScheduleRepository.save (real MongoDB)',
    () => {
        let connection: Connection;
        let model: Model<SecurityScanScheduleModel>;
        let schedules: SecurityScanScheduleRepository;
        const repository = {
            platform: 'GITHUB',
            host: 'github.com',
            id: 'repo-1',
        };
        const settings = {
            teamId: 'team-1',
            cadence: 'daily' as const,
            budget: { maxUsd: 5 },
            mode: 'incremental' as const,
            nextRunAt: '2026-11-25T03:00:00.000Z',
        };
        const stored = async (organizationId: string, id: string) =>
            (await model
                .findOne({ organizationId, 'repository.id': id })
                .lean()
                .exec()) as any;

        beforeAll(async () => {
            connection = await mongoose
                .createConnection(gate.mongoUri, {
                    dbName: TEST_DB,
                    serverSelectionTimeoutMS: 5000,
                })
                .asPromise();
            await connection.dropDatabase();
            model = connection.model<SecurityScanScheduleModel>(
                SecurityScanScheduleModel.name,
                SecurityScanScheduleSchema,
            );
            await model.syncIndexes();
            schedules = new SecurityScanScheduleRepository(model as any);
        }, 30_000);

        beforeEach(async () => {
            await model.deleteMany({});
        });

        afterAll(async () => {
            await connection?.dropDatabase();
            await connection?.close();
        });

        it('creates a schedule enabled, and an edit without enabled keeps it paused', async () => {
            await schedules.save('org-1', repository, settings);
            expect((await stored('org-1', 'repo-1')).enabled).toBe(true);

            await schedules.save('org-1', repository, {
                ...settings,
                enabled: false,
            });
            await schedules.save('org-1', repository, {
                ...settings,
                cadence: 'weekly',
            });

            const doc = await stored('org-1', 'repo-1');
            expect(doc.enabled).toBe(false);
            expect(doc.cadence).toBe('weekly');
            expect(await model.countDocuments({})).toBe(1);
        });

        it('resumes when told', async () => {
            await schedules.save('org-1', repository, {
                ...settings,
                enabled: false,
            });
            await schedules.save('org-1', repository, {
                ...settings,
                enabled: true,
            });

            expect((await stored('org-1', 'repo-1')).enabled).toBe(true);
        });

        it('pauses and resumes with nothing else changed', async () => {
            await schedules.save('org-1', repository, {
                ...settings,
                cadence: 'weekly',
                modelId: 'model-1',
            });
            const next = new Date('2026-12-01T03:00:00.000Z');

            await schedules.setEnabled('org-1', repository, false);
            expect(await stored('org-1', 'repo-1')).toMatchObject({
                enabled: false,
                cadence: 'weekly',
                modelId: 'model-1',
            });

            const resumed = await schedules.setEnabled(
                'org-1',
                repository,
                true,
                next,
            );
            expect(resumed?.enabled).toBe(true);
            expect((await stored('org-1', 'repo-1')).nextRunAt).toEqual(next);
            expect(
                await schedules.setEnabled('org-2', repository, true),
            ).toBeNull();
        });

        it('an edit keeps the next run the cron moved, and a new cadence counts from the last run', async () => {
            const useCase = new SecurityScanSchedulesUseCase(
                schedules,
                {
                    scanModelFor: jest.fn(async () => undefined),
                    repositoryKeyOf: jest.fn(async () => repository),
                } as any,
                {} as any,
                {} as any, // scans: listing is not exercised here
            );
            const orgTeam = { organizationId: 'org-1', teamId: 'team-1' };
            const now = new Date('2026-11-24T10:00:00.000Z');
            const created = await useCase.save(
                {
                    organizationAndTeamData: orgTeam,
                    repositoryId: 'repo-1',
                    cadence: 'daily',
                    budget: { maxUsd: 5 },
                },
                now,
            );
            expect((await stored('org-1', 'repo-1')).nextRunAt).toEqual(
                new Date('2026-11-25T03:00:00.000Z'),
            );
            // The cron ran it and handed it back to 03:30 (no room).
            await schedules.recordRun(created.uuid, {
                lastRunAt: '2026-11-25T03:00:00.000Z',
            });
            expect(
                await schedules.claim(
                    created.uuid,
                    '2026-11-25T03:00:00.000Z',
                    new Date('2026-11-25T03:30:00.000Z'),
                ),
            ).toBe(true);

            await useCase.save(
                {
                    organizationAndTeamData: orgTeam,
                    repositoryId: 'repo-1',
                    cadence: 'daily',
                    budget: { maxUsd: 9 },
                },
                now,
            );
            const edited = await stored('org-1', 'repo-1');
            expect(edited.budget).toEqual({ maxUsd: 9 });
            expect(edited.nextRunAt).toEqual(
                new Date('2026-11-25T03:30:00.000Z'),
            );

            await useCase.save(
                {
                    organizationAndTeamData: orgTeam,
                    repositoryId: 'repo-1',
                    cadence: 'weekly',
                    budget: { maxUsd: 9 },
                },
                new Date('2026-11-25T10:00:00.000Z'),
            );
            // A week after the last run, not a day after the edit.
            expect((await stored('org-1', 'repo-1')).nextRunAt).toEqual(
                new Date('2026-12-02T03:00:00.000Z'),
            );
        });

        it('a run with no room is stored to try again in 30 minutes, with why', async () => {
            await schedules.save('org-1', repository, settings);
            const useCase = new SecurityScanSchedulesUseCase(
                schedules,
                {
                    execute: jest.fn(async () => {
                        throw new ConflictException(
                            'A security scan of this repository is already running.',
                        );
                    }),
                } as any,
                { isEnabledFor: jest.fn(async () => true) } as any,
                {} as any, // scans: listing is not exercised here
            );

            expect(
                await useCase.runDue(new Date('2026-11-25T03:01:00.000Z')),
            ).toBe(0);

            const doc = await stored('org-1', 'repo-1');
            expect(doc.nextRunAt).toEqual(new Date('2026-11-25T03:31:00.000Z'));
            expect(doc.lastError).toBe(
                'This repository is already being scanned. It tries again at 03:31 UTC.',
            );
            // Not a run: the last run stays as it was.
            expect(doc.lastRunAt).toBeUndefined();
        });

        it("touches only its own organization's and repository's schedule", async () => {
            await schedules.save('org-2', repository, {
                ...settings,
                enabled: false,
            });
            await schedules.save(
                'org-1',
                { ...repository, id: 'repo-2' },
                {
                    ...settings,
                    enabled: false,
                },
            );

            await schedules.save('org-1', repository, {
                ...settings,
                cadence: 'weekly',
            });

            expect((await stored('org-1', 'repo-1')).enabled).toBe(true);
            expect(await stored('org-2', 'repo-1')).toMatchObject({
                enabled: false,
                cadence: 'daily',
            });
            expect(await stored('org-1', 'repo-2')).toMatchObject({
                enabled: false,
                cadence: 'daily',
            });
        });
    },
);
