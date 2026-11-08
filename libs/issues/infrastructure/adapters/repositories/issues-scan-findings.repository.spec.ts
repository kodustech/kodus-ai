import { IssueStatus } from '@libs/core/infrastructure/config/types/general/issues.type';
import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { IssueSource } from '@libs/issues/domain/interfaces/issues.interface';

import { IssuesRepository } from './issues.repository';

const exec = (value: unknown) => ({ exec: jest.fn(async () => value) });

const finding = {
    title: 'Order lookup skips the owner check',
    description: 'Any signed-in user can read any order by id.',
    filePath: 'src/orders/orders.controller.ts',
    language: 'typescript',
    label: LabelType.SECURITY,
    severity: SeverityLevel.HIGH,
    repository: {
        id: 'repo-1',
        name: 'shop',
        full_name: 'acme/shop',
        platform: PlatformType.GITHUB,
    },
    organizationId: 'org-1',
    fingerprint: 'fp-1',
    cwe: 'CWE-639',
    vulnerabilityClass: 'authz',
    symbol: 'OrdersController.findOne',
    startLine: 10,
    endLine: 14,
    lastSeenScanId: 'scan-2',
    owner: { gitId: '', username: 'ana', origin: 'codeowners' as const },
};

function modelWith(existing: Record<string, unknown> | null) {
    return {
        findOne: jest.fn(() => exec(existing)),
        create: jest.fn(async (doc) => ({ ...doc, _id: 'new-id' })),
        findByIdAndUpdate: jest.fn(async (_id, update) => ({
            ...existing,
            ...(update.$set ?? {}),
        })),
        findById: jest.fn(() => exec(existing)),
        updateMany: jest.fn(async () => ({ modifiedCount: 3 })),
    };
}

describe('IssuesRepository — security-scan findings', () => {
    it('creates an open security-scan issue the first time a finding is seen', async () => {
        const model = modelWith(null);
        const repository = new IssuesRepository(model as any);

        const { outcome } = await repository.upsertScanFinding(finding);

        expect(outcome).toBe('created');
        expect(model.create).toHaveBeenCalledWith(
            expect.objectContaining({
                source: IssueSource.SECURITY_SCAN,
                status: IssueStatus.OPEN,
                fingerprint: 'fp-1',
                contributingSuggestions: [],
            }),
        );
        expect(model.findOne).toHaveBeenCalledWith({
            'organizationId': 'org-1',
            'repository.id': 'repo-1',
            'fingerprint': 'fp-1',
        });
    });

    it('refreshes a finding that is still open without touching its owner', async () => {
        const model = modelWith({
            _id: 'i-1',
            status: IssueStatus.OPEN,
            owner: { gitId: '9', username: 'reassigned' },
        });
        const repository = new IssuesRepository(model as any);

        const { outcome } = await repository.upsertScanFinding(finding);

        expect(outcome).toBe('still_open');
        const update = model.findByIdAndUpdate.mock.calls[0][1];
        expect(update.$set).toEqual(
            expect.objectContaining({
                lastSeenScanId: 'scan-2',
                startLine: 10,
            }),
        );
        expect(update.$set.owner).toBeUndefined();
        expect(update.$set.status).toBeUndefined();
    });

    it('reopens a finding a later change had resolved', async () => {
        const model = modelWith({
            _id: 'i-1',
            status: IssueStatus.RESOLVED,
            resolvedAt: '2026-11-01T00:00:00.000Z',
        });
        const repository = new IssuesRepository(model as any);

        const { outcome } = await repository.upsertScanFinding(finding);

        expect(outcome).toBe('reopened');
        const update = model.findByIdAndUpdate.mock.calls[0][1];
        expect(update.$set.status).toBe(IssueStatus.OPEN);
        expect(update.$unset).toEqual({ resolvedAt: '' });
    });

    it('leaves a dismissed finding dismissed and only records the sighting', async () => {
        const model = modelWith({ _id: 'i-1', status: IssueStatus.DISMISSED });
        const repository = new IssuesRepository(model as any);

        const { outcome } = await repository.upsertScanFinding(finding);

        expect(outcome).toBe('dismissed');
        const update = model.findByIdAndUpdate.mock.calls[0][1];
        expect(Object.keys(update.$set).sort()).toEqual([
            'lastSeenAt',
            'lastSeenScanId',
        ]);
    });

    it('updates the issue another worker created first instead of failing', async () => {
        const model = modelWith(null);
        model.findOne
            .mockImplementationOnce(() => exec(null))
            .mockImplementationOnce(() =>
                exec({ _id: 'i-1', status: IssueStatus.OPEN }),
            );
        model.create.mockRejectedValueOnce(
            Object.assign(new Error('E11000 duplicate key'), { code: 11000 }),
        );
        const repository = new IssuesRepository(model as any);

        const { outcome } = await repository.upsertScanFinding(finding);

        expect(outcome).toBe('still_open');
        expect(model.findByIdAndUpdate).toHaveBeenCalled();
    });

    it('resolves only open scan issues in the files this scan examined and did not see again', async () => {
        const model = modelWith(null);
        const repository = new IssuesRepository(model as any);

        const resolved = await repository.resolveUnseenScanFindings({
            organizationId: 'org-1',
            repositoryId: 'repo-1',
            scanId: 'scan-2',
            filePaths: ['src/a.ts', 'src/b.ts'],
        });

        expect(resolved).toBe(3);
        expect((model.updateMany.mock.calls[0] as unknown[])[0]).toEqual({
            'organizationId': 'org-1',
            'repository.id': 'repo-1',
            'source': IssueSource.SECURITY_SCAN,
            'status': IssueStatus.OPEN,
            'filePath': { $in: ['src/a.ts', 'src/b.ts'] },
            'lastSeenScanId': { $ne: 'scan-2' },
        });
    });

    it('resolves nothing when the scan examined no file', async () => {
        const model = modelWith(null);
        const repository = new IssuesRepository(model as any);

        await expect(
            repository.resolveUnseenScanFindings({
                organizationId: 'org-1',
                repositoryId: 'repo-1',
                scanId: 'scan-2',
                filePaths: [],
            }),
        ).resolves.toBe(0);
        expect(model.updateMany).not.toHaveBeenCalled();
    });
});

describe('IssuesRepository.addContributingSuggestions', () => {
    it('pushes only suggestions the issue does not already have', async () => {
        const model = modelWith({
            _id: 'i-1',
            contributingSuggestions: [{ id: 's1' }],
        });
        const repository = new IssuesRepository(model as any);

        await repository.addContributingSuggestions('i-1', [
            { id: 's1', prNumber: 1, prAuthor: { id: '1', name: 'a' } },
            { id: 's2', prNumber: 2, prAuthor: { id: '1', name: 'a' } },
        ]);

        expect(model.findByIdAndUpdate).toHaveBeenCalledWith(
            'i-1',
            {
                $push: {
                    contributingSuggestions: {
                        $each: [
                            {
                                id: 's2',
                                prNumber: 2,
                                prAuthor: { id: '1', name: 'a' },
                            },
                        ],
                    },
                },
            },
            { new: true },
        );
    });

    it('writes nothing when every suggestion is already there', async () => {
        const model = modelWith({
            _id: 'i-1',
            contributingSuggestions: [{ id: 's1' }],
        });
        const repository = new IssuesRepository(model as any);

        await repository.addContributingSuggestions('i-1', [
            { id: 's1', prNumber: 1, prAuthor: { id: '1', name: 'a' } },
        ]);

        expect(model.findByIdAndUpdate).not.toHaveBeenCalled();
    });
});
