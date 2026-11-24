/**
 * INTEGRATION TEST — SandboxLeaseRepository.claimCleanup.
 *
 * The single-use release relies on the claim and `killAt` landing in ONE
 * MongoDB write: `findReadyToKill` only reads `killAt`, so a claim without it
 * would keep the sandbox billing until the lease TTL (#2626). The unit spec
 * stubs `findOneAndUpdate` and can only pin the shape of the arguments; this
 * suite writes, reloads the stored document and asserts what Mongo actually
 * kept.
 *
 * Requires a running MongoDB — see resolveMongoTestGate.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
    SANDBOX_LEASE_CLEANUP_STATUS,
    SandboxLeaseModel,
    SandboxLeaseSchema,
} from '@libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model';
import { SandboxLeaseRepository } from '@libs/sandbox/infrastructure/repositories/sandbox-lease.repository';
import { resolveMongoTestGate } from '../mongo-test-uri';

const { shouldSkip, mongoUri } = resolveMongoTestGate(
    'kodus_test_claim_cleanup',
);

(shouldSkip ? describe.skip : describe)(
    'SandboxLeaseRepository.claimCleanup — persisted state',
    () => {
        const ORG = '11111111-1111-4111-8111-111111111111';
        const REPO = 'repo';
        const PR_KEY = `${ORG}:${REPO}:42`;

        let moduleRef: TestingModule;
        let model: Model<SandboxLeaseModel>;
        let repository: SandboxLeaseRepository;

        beforeAll(async () => {
            moduleRef = await Test.createTestingModule({
                imports: [
                    MongooseModule.forRoot(mongoUri),
                    MongooseModule.forFeature([
                        {
                            name: SandboxLeaseModel.name,
                            schema: SandboxLeaseSchema,
                        },
                    ]),
                ],
            }).compile();

            model = moduleRef.get<Model<SandboxLeaseModel>>(
                getModelToken(SandboxLeaseModel.name),
            );
            repository = new SandboxLeaseRepository(model);
        });

        afterAll(async () => {
            // Scoped to this suite's key: CI points TEST_MONGODB_URI at a full
            // connection string, so the gate's dbName is ignored and the
            // collection may be shared with other integration suites.
            await model.deleteMany({ _id: PR_KEY });
            await moduleRef.close();
        });

        beforeEach(async () => {
            await model.deleteMany({ _id: PR_KEY });
            await model.create({
                _id: PR_KEY,
                state: 'READY',
                leaseCount: 0,
                sandboxId: 'sbx-1',
                organizationId: ORG,
                repositoryId: REPO,
                prNumber: '42',
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            });
        });

        const stored = () =>
            model.findById(PR_KEY).lean().exec() as Promise<any>;

        it('persists killAt in the same document write as the claim', async () => {
            const killAt = new Date('2026-11-22T12:00:00.000Z');

            const claimed = await repository.claimCleanup(
                PR_KEY,
                'sbx-1',
                true,
                killAt,
            );
            expect(claimed).not.toBeNull();

            const doc = await stored();
            expect(doc.cleanupStatus).toBe(
                SANDBOX_LEASE_CLEANUP_STATUS.IN_PROGRESS,
            );
            expect(doc.killAt).toEqual(killAt);
            expect(doc.cleanupAttempts).toBe(1);
        });

        it('refuses the claim while a holder remains, then claims once it drains', async () => {
            await model.updateOne({ _id: PR_KEY }, { $set: { leaseCount: 1 } });
            const killAt = new Date('2026-11-22T12:00:00.000Z');

            const refused = await repository.claimCleanup(
                PR_KEY,
                'sbx-1',
                true,
                killAt,
            );
            expect(refused).toBeNull();

            const untouched = await stored();
            expect(untouched.cleanupStatus).toBeUndefined();
            expect(untouched.killAt).toBeUndefined();

            // Drain the last holder: the same call must now win and persist
            // killAt with the claim. Fails on the pre-fix write, which never
            // stores killAt.
            await model.updateOne({ _id: PR_KEY }, { $set: { leaseCount: 0 } });
            const claimed = await repository.claimCleanup(
                PR_KEY,
                'sbx-1',
                true,
                killAt,
            );
            expect(claimed).not.toBeNull();

            const doc = await stored();
            expect(doc.cleanupStatus).toBe(
                SANDBOX_LEASE_CLEANUP_STATUS.IN_PROGRESS,
            );
            expect(doc.killAt).toEqual(killAt);
        });
    },
);
