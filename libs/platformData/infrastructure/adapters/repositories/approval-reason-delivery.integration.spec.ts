import { CommentManagerService } from '@libs/code-review/infrastructure/adapters/services/commentManager.service';
import { CheckIfPRCanBeApprovedCronProvider } from '../../../../../apps/api/src/cron/CheckIfPRCanBeApproved.cron';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { PullRequestsService } from '../services/pullRequests.service';
import { randomUUID } from 'node:crypto';
import mongoose, { Connection, Model } from 'mongoose';
import { resolveMongoTestGate } from '../../../../../test/integration/mongo-test-uri';
import { PullRequestsRepository } from './pullRequests.repository';
import {
    PullRequestsModel,
    PullRequestsSchema,
} from './schemas/pullRequests.model';

const gate = resolveMongoTestGate();
const describeMongo = gate.shouldSkip ? describe.skip : describe;

describeMongo('approval reason delivery ordering on real Mongo', () => {
    let connection: Connection;
    let model: Model<PullRequestsModel>;
    let repository: PullRequestsRepository;
    const old = {
        decision: 'approve' as const,
        reason: 'Old policy',
        reviewedHeadSha: 'head-1',
        reviewedBaseSha: 'base',
        occurredAt: '2026-11-10T10:00:00.000Z',
    };
    const newer = {
        ...old,
        reason: 'New policy',
        reviewedHeadSha: 'head-2',
        occurredAt: '2026-11-10T10:00:01.000Z',
    };
    const write = (failure, options?) =>
        repository.setApprovalReasonDeliveryFailure(
            'org',
            'repo',
            1,
            failure,
            options,
        );
    const read = () =>
        model.collection.findOne({ organizationId: 'org', number: 1 });
    beforeAll(async () => {
        connection = await mongoose
            .createConnection(gate.mongoUri, {
                dbName: `kodus_approval_delivery_${randomUUID().replaceAll('-', '')}`,
                autoIndex: false,
                serverSelectionTimeoutMS: 5000,
            })
            .asPromise();
        model = connection.model(PullRequestsModel.name, PullRequestsSchema);
        repository = new PullRequestsRepository(model);
    });
    beforeEach(async () => {
        await model.collection.deleteMany({});
        await model.collection.insertOne({
            organizationId: 'org',
            repository: { id: 'repo' },
            number: 1,
        } as any);
    });
    afterAll(async () => {
        await connection?.dropDatabase();
        await connection?.close();
    });

    it('keeps the newer snapshot when an older publication fails late', async () => {
        expect(await write(old)).toBe(true);
        expect(await write(newer)).toBe(true);
        expect(await write(old)).toBe(false);
        expect((await read()).approvalReasonDeliveryFailure).toEqual(newer);
    });
    it('does not clear a replacement notice while repairing the old one', async () => {
        await write(old);
        await write(newer);
        expect(
            await write(null, {
                expectedFailure: old,
                notAfter: '2026-11-10T10:00:02.000Z',
            }),
        ).toBe(false);
        expect((await read()).approvalReasonDeliveryFailure).toEqual(newer);
    });
    it('does not clear a newer failure after an older publication succeeds late', async () => {
        await write(newer);
        expect(await write(null, { notAfter: old.occurredAt })).toBe(false);
        expect((await read()).approvalReasonDeliveryFailure).toEqual(newer);
    });
    it.each([false, true])(
        'retains a successful delivery watermark (prior failure: %s)',
        async (priorFailure) => {
            if (priorFailure) await write(newer);
            expect(
                await write(null, {
                    ...(priorFailure ? { expectedFailure: newer } : {}),
                    notAfter: newer.occurredAt,
                }),
            ).toBe(true);
            expect(await write(old)).toBe(false);
            expect((await read()).approvalReasonDeliveryFailure).toBeNull();
        },
    );
    it('preserves a same-time replacement notice when the expected record differs', async () => {
        await write(old);
        const replacement = { ...newer, occurredAt: old.occurredAt };
        await write(replacement);
        await write(null, { expectedFailure: old, notAfter: newer.occurredAt });
        expect((await read()).approvalReasonDeliveryFailure).toEqual(
            replacement,
        );
    });
    it('refuses a late failed repair after another snapshot replaces its notice', async () => {
        await write(old);
        await write(newer);
        expect(await write(old, { expectedFailure: old })).toBe(false);
        expect((await read()).approvalReasonDeliveryFailure).toEqual(newer);
    });
    it('does not let an old repair suppress an in-flight newer publication', async () => {
        await write(old);
        expect(
            await write(null, {
                expectedFailure: old,
                notAfter: '2026-11-10T10:00:02.000Z',
            }),
        ).toBe(true);
        expect(await write(newer)).toBe(true);
        expect(await write(old)).toBe(false);
        expect((await read()).approvalReasonDeliveryFailure).toEqual(newer);
    });
    it.each(['fail', 'succeed'])(
        'keeps a newer notice when an older publisher finishes late: %s',
        async (outcome) => {
            const service = Object.assign(
                Object.create(PullRequestsService.prototype),
                { pullRequestsRepository: repository },
            );
            const code = {
                getAllCommentsInPullRequest: async () => [],
                createIssueComment: async () => {
                    await write(newer);
                    if (outcome === 'fail')
                        throw new Error('Old provider failure');
                    return { id: 42 };
                },
            };
            const publisher = new CommentManagerService(
                {} as any,
                {} as any,
                {} as any,
                {} as any,
                code as any,
                service,
            );
            const publication = publisher.postApprovalReason(
                { organizationId: 'org', teamId: 'team' },
                1,
                { id: 'repo', name: 'api' },
                old.reason,
                'approve',
                {
                    confirmedApproval: {
                        headSha: 'head-1',
                        baseSha: 'base',
                        occurredAt: old.occurredAt,
                    },
                },
            );
            if (outcome === 'fail')
                await expect(publication).rejects.toThrow(
                    'Old provider failure',
                );
            else await publication;
            expect((await read()).approvalReasonDeliveryFailure).toEqual(newer);
        },
    );
    it.each(['fail', 'succeed'])(
        'keeps a replacement notice when an old cron repair finishes: %s',
        async (outcome) => {
            await write(old);
            const service = Object.assign(
                Object.create(PullRequestsService.prototype),
                { pullRequestsRepository: repository },
            );
            const cron = Object.assign(
                Object.create(CheckIfPRCanBeApprovedCronProvider.prototype),
                {
                    pullRequestService: service,
                    logger: { warn: jest.fn(), error: jest.fn() },
                    codeManagementService: {
                        getAllCommentsInPullRequest: async () => [],
                        createIssueComment: async () => {
                            await write(newer);
                            if (outcome === 'fail')
                                throw new Error('Old repair failed');
                            return { id: 42 };
                        },
                    },
                },
            );
            await cron.postConditionalApprovalReason(
                {
                    organizationAndTeamData: {
                        organizationId: 'org',
                        teamId: 'team',
                    },
                    repository: { id: 'repo', name: 'api' },
                    prNumber: 1,
                },
                PlatformType.GITHUB,
                {
                    kind: 'approve',
                    reason: old.reason,
                    reviewedHeadSha: 'head-1',
                    reviewedBaseSha: 'base',
                },
                old,
            );
            expect((await read()).approvalReasonDeliveryFailure).toEqual(newer);
        },
    );
    it('protects notices stored before the ordering watermark existed', async () => {
        await model.collection.updateOne(
            { organizationId: 'org', number: 1 },
            { $set: { approvalReasonDeliveryFailure: newer } },
        );
        expect(await write(old)).toBe(false);
        expect((await read()).approvalReasonDeliveryFailure).toEqual(newer);
    });
});
