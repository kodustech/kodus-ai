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
        findOneAndUpdate: jest.fn(async (_id, update) => ({
            ...existing,
            ...(update.$set ?? {}),
        })),
        findById: jest.fn(() => exec(existing)),
        updateMany: jest.fn(async () => ({ modifiedCount: 3 })),
        distinct: jest.fn(() => exec(['src/a.ts', 'src/gone.ts', ''])),
        updateOne: jest.fn(async () => ({ modifiedCount: 1 })),
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

    it('moves an owner the scan set when CODEOWNERS now names someone else', async () => {
        const model = modelWith({
            _id: 'i-1',
            status: IssueStatus.OPEN,
            owner: { gitId: '', username: 'old', origin: 'last_author' },
        });
        const repository = new IssuesRepository(model as any);

        await repository.upsertScanFinding(finding);

        const update = model.findOneAndUpdate.mock.calls[0][1];
        expect(update.$set.owner).toEqual(finding.owner);
    });

    it('refreshes a finding that is still open without touching an owner a person set', async () => {
        const model = modelWith({
            _id: 'i-1',
            status: IssueStatus.OPEN,
            owner: { gitId: '9', username: 'reassigned' },
        });
        const repository = new IssuesRepository(model as any);

        const { outcome } = await repository.upsertScanFinding(finding);

        expect(outcome).toBe('still_open');
        const update = model.findOneAndUpdate.mock.calls[0][1];
        expect(update.$set).toEqual(
            expect.objectContaining({
                lastSeenScanId: 'scan-2',
                startLine: 10,
            }),
        );
        expect(update.$set.owner).toBeUndefined();
        expect(update.$set.status).toBeUndefined();
    });

    it('writes only while the status it decided on still holds', async () => {
        const model = modelWith({ _id: 'i-1', status: IssueStatus.RESOLVED });
        const repository = new IssuesRepository(model as any);

        await repository.upsertScanFinding(finding);

        expect(model.findOneAndUpdate.mock.calls[0][0]).toEqual({
            _id: 'i-1',
            status: IssueStatus.RESOLVED,
        });
    });

    it('keeps a finding a person dismissed between the read and the write', async () => {
        const model = modelWith({ _id: 'i-1', status: IssueStatus.RESOLVED });
        // The resolved finding is dismissed just before the reopen lands.
        model.findOneAndUpdate
            .mockResolvedValueOnce(null)
            .mockImplementationOnce(async (_filter: any, update: any) => ({
                _id: 'i-1',
                status: IssueStatus.DISMISSED,
                ...update.$set,
            }));
        model.findOne
            .mockReturnValueOnce(
                exec({ _id: 'i-1', status: IssueStatus.RESOLVED }),
            )
            .mockReturnValueOnce(
                exec({ _id: 'i-1', status: IssueStatus.DISMISSED }),
            );
        const repository = new IssuesRepository(model as any);

        const { outcome } = await repository.upsertScanFinding(finding);

        expect(outcome).toBe('dismissed');
        const retry = model.findOneAndUpdate.mock.calls[1];
        expect(retry[0]).toEqual({ _id: 'i-1', status: IssueStatus.DISMISSED });
        expect(retry[1].$set.status).toBeUndefined();
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
        const update = model.findOneAndUpdate.mock.calls[0][1];
        expect(update.$set.status).toBe(IssueStatus.OPEN);
        expect(update.$unset).toEqual({ resolvedAt: '' });
    });

    it('leaves a dismissed finding dismissed and only records the sighting', async () => {
        const model = modelWith({ _id: 'i-1', status: IssueStatus.DISMISSED });
        const repository = new IssuesRepository(model as any);

        const { outcome } = await repository.upsertScanFinding(finding);

        expect(outcome).toBe('dismissed');
        const update = model.findOneAndUpdate.mock.calls[0][1];
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
        expect(model.findOneAndUpdate).toHaveBeenCalled();
    });

    it('keeps a second weakness of the same identity in one scan as another occurrence', async () => {
        // Two SQL injections in one function: the first is stored by this
        // scan, the second arrives with the same identity.
        const first = {
            _id: 'i-1',
            status: IssueStatus.OPEN,
            lastSeenScanId: 'scan-2',
            description: 'Injection in the name filter.',
            severity: SeverityLevel.HIGH,
        };
        const model = modelWith(first);
        const repository = new IssuesRepository(model as any);

        const { outcome } = await repository.upsertScanFinding({
            ...finding,
            title: 'Injection in the sort column',
            description: 'The sort column is concatenated into the query.',
            severity: SeverityLevel.MEDIUM,
            startLine: 30,
            endLine: 31,
        });

        expect(outcome).toBe('merged');
        const [filter, update] = model.findOneAndUpdate.mock.calls[0] as unknown as [any, any];
        // Written only if no other occurrence landed since the read.
        expect(filter).toEqual({
            _id: 'i-1',
            status: IssueStatus.OPEN,
            description: 'Injection in the name filter.',
        });
        expect(update.$set.description).toContain('Injection in the name filter.');
        expect(update.$set.description).toContain(
            'Also in this function: Injection in the sort column',
        );
        expect(update.$set.description).toContain('Lines 30-31');
        // The worse of the two: the stored one here, not the incoming.
        expect(update.$set.severity).toBe(SeverityLevel.HIGH);
        expect(update.$set.title).toBeUndefined();
        expect(update.$set.status).toBeUndefined();
    });

    it('reopens an issue resolved between two occurrences of one scan', async () => {
        const model = modelWith({
            _id: 'i-1',
            status: IssueStatus.RESOLVED,
            lastSeenScanId: 'scan-2',
            description: 'Injection in the name filter.',
            severity: SeverityLevel.HIGH,
        });
        const repository = new IssuesRepository(model as any);

        const { outcome } = await repository.upsertScanFinding(finding);

        expect(outcome).toBe('merged');
        const update = (model.findOneAndUpdate.mock.calls[0] as unknown as [any, any])[1];
        expect(update.$set.status).toBe(IssueStatus.OPEN);
        expect(update.$unset).toEqual({ resolvedAt: '' });
    });

    it('stores again a finding deleted between the read and the write', async () => {
        const model = modelWith(null);
        model.findOne
            .mockImplementationOnce(() =>
                exec({ _id: 'i-1', status: IssueStatus.OPEN }),
            )
            .mockImplementationOnce(() => exec(null));
        model.findOneAndUpdate.mockResolvedValueOnce(null);
        const repository = new IssuesRepository(model as any);

        const { outcome, issue } = await repository.upsertScanFinding(finding);

        expect(outcome).toBe('created');
        expect(model.create).toHaveBeenCalledTimes(1);
        expect(model.create).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationId: 'org-1',
                repository: expect.objectContaining({ id: 'repo-1' }),
                fingerprint: 'fp-1',
                source: IssueSource.SECURITY_SCAN,
                status: IssueStatus.OPEN,
                lastSeenScanId: 'scan-2',
            }),
        );
        expect(issue.status).toBe(IssueStatus.OPEN);
    });

    it('fails with the real error when a different unique index keeps refusing the create', async () => {
        const model = modelWith(null);
        const collision = Object.assign(new Error('E11000 on another index'), {
            code: 11000,
        });
        model.create.mockRejectedValue(collision);
        const repository = new IssuesRepository(model as any);

        await expect(repository.upsertScanFinding(finding)).rejects.toBe(
            collision,
        );
        expect(model.create).toHaveBeenCalledTimes(3);
    });

    it('stores a finding whose create raced a write deleted right after', async () => {
        const model = modelWith(null);
        model.create.mockRejectedValueOnce(
            Object.assign(new Error('E11000 duplicate key'), { code: 11000 }),
        );
        const repository = new IssuesRepository(model as any);

        const { outcome } = await repository.upsertScanFinding(finding);

        expect(outcome).toBe('created');
        expect(model.create).toHaveBeenCalledTimes(2);
    });

    it('fails, rather than guess an outcome, when the finding changes under every write', async () => {
        const model = modelWith({ _id: 'i-1', status: IssueStatus.RESOLVED });
        model.findOneAndUpdate.mockResolvedValue(null);
        const repository = new IssuesRepository(model as any);

        await expect(repository.upsertScanFinding(finding)).rejects.toThrow(
            /kept changing/,
        );
        expect(model.findOneAndUpdate).toHaveBeenCalledTimes(3);
    });

    const unseen = {
        'organizationId': 'org-1',
        'repository.id': 'repo-1',
        'source': IssueSource.SECURITY_SCAN,
        'status': IssueStatus.OPEN,
        'lastSeenScanId': { $ne: 'scan-2' },
        // A newer, overlapping scan's sightings are not this one's to resolve.
        'lastSeenAt': { $lt: '2026-11-08T10:00:00.000Z' },
    };

    it('resolves only open scan issues of a class in the files a lens of that class examined', async () => {
        const model = modelWith(null);
        const repository = new IssuesRepository(model as any);

        const resolved = await repository.resolveUnseenScanFindings({
            organizationId: 'org-1',
            repositoryId: 'repo-1',
            scanId: 'scan-2',
            // A scan may spell a path as it was found; the issue stores it clean.
            examined: [
                { vulnerabilityClass: 'authz', filePaths: ['./src/a.ts', 'src\\b.ts'] },
                { vulnerabilityClass: 'injection', filePaths: [] },
            ],
            scanStartedAt: '2026-11-08T10:00:00.000Z',
        });

        expect(resolved).toBe(3);
        expect((model.updateMany.mock.calls[0] as unknown[])[0]).toEqual({
            ...unseen,
            $or: [
                {
                    vulnerabilityClass: 'authz',
                    filePath: { $in: ['src/a.ts', 'src/b.ts'] },
                },
            ],
        });
        expect(model.distinct).not.toHaveBeenCalled();
    });

    it('resolves the open findings of a file the scanned branch no longer tracks', async () => {
        const model = modelWith(null);
        const repository = new IssuesRepository(model as any);

        await repository.resolveUnseenScanFindings({
            organizationId: 'org-1',
            repositoryId: 'repo-1',
            scanId: 'scan-2',
            examined: [],
            trackedFiles: ['./src/a.ts'],
            scanStartedAt: '2026-11-08T10:00:00.000Z',
        });

        expect(model.distinct).toHaveBeenCalledWith('filePath', unseen);
        expect((model.updateMany.mock.calls[0] as unknown[])[0]).toEqual({
            ...unseen,
            $or: [{ filePath: { $in: ['src/gone.ts'] } }],
        });
    });

    it('resolves nothing when the scan examined no file and read no file list', async () => {
        const model = modelWith(null);
        const repository = new IssuesRepository(model as any);

        await expect(
            repository.resolveUnseenScanFindings({
                organizationId: 'org-1',
                repositoryId: 'repo-1',
                scanId: 'scan-2',
                examined: [{ vulnerabilityClass: 'authz', filePaths: [] }],
                trackedFiles: [],
                scanStartedAt: '2026-11-08T10:00:00.000Z',
            }),
        ).resolves.toBe(0);
        expect(model.updateMany).not.toHaveBeenCalled();
    });
});

describe('IssuesRepository.addContributingSuggestions', () => {
    it('adds each suggestion only while the issue does not have it, in one atomic write each', async () => {
        const model = modelWith({ _id: 'i-1', contributingSuggestions: [] });
        const repository = new IssuesRepository(model as any);
        const s1 = { id: 's1', prNumber: 1, prAuthor: { id: '1', name: 'a' } };
        const s2 = { id: 's2', prNumber: 2, prAuthor: { id: '1', name: 'a' } };

        await repository.addContributingSuggestions(
            'i-1',
            [s1, s2, s1],
            'org-1',
        );

        // The filter carries the "not there yet" check, so two writers
        // merging the same PR cannot both push it, and the organization, so
        // an id a model answered with cannot reach another tenant's issue.
        expect(model.updateOne.mock.calls).toEqual([
            [
                {
                    '_id': 'i-1',
                    'organizationId': 'org-1',
                    'contributingSuggestions.id': { $ne: 's1' },
                },
                { $push: { contributingSuggestions: s1 } },
            ],
            [
                {
                    '_id': 'i-1',
                    'organizationId': 'org-1',
                    'contributingSuggestions.id': { $ne: 's2' },
                },
                { $push: { contributingSuggestions: s2 } },
            ],
        ]);
    });
});

describe('IssuesRepository.updateStatusByIds', () => {
    it('stamps resolvedAt when it resolves, as the scan does', async () => {
        const model = {
            updateMany: jest.fn(async (_filter: any, _update: any) => ({})),
            find: jest.fn(async () => []),
        };
        const repository = new IssuesRepository(model as any);

        await repository.updateStatusByIds(['i-1'], IssueStatus.RESOLVED);
        await repository.updateStatusByIds(['i-2'], IssueStatus.DISMISSED);

        expect(model.updateMany.mock.calls[0][1].$set).toEqual({
            status: IssueStatus.RESOLVED,
            resolvedAt: expect.any(String),
        });
        expect(model.updateMany.mock.calls[1][1].$set).toEqual({
            status: IssueStatus.DISMISSED,
        });
    });
});

describe('IssuesRepository.findByFileAndStatus', () => {
    it('does not throw on a file without a path', async () => {
        const model = { find: jest.fn(async (_filter: any) => []) };
        const repository = new IssuesRepository(model as any);

        await repository.findByFileAndStatus(
            'org-1',
            'repo-1',
            undefined as any,
            IssueStatus.OPEN,
        );

        expect(model.find.mock.calls[0][0].filePath).toEqual({ $in: [''] });
    });

    it('finds a scan issue stored normalized when the caller spells the path another way', async () => {
        const model = { find: jest.fn(async () => []) };
        const repository = new IssuesRepository(model as any);

        await repository.findByFileAndStatus(
            'org-1',
            'repo-1',
            './src/a.ts',
            IssueStatus.OPEN,
        );

        expect((model.find.mock.calls[0] as unknown[])[0]).toEqual(
            expect.objectContaining({
                filePath: { $in: ['./src/a.ts', 'src/a.ts'] },
            }),
        );
    });
});
