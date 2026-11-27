import { IssueStatus } from '@libs/core/infrastructure/config/types/general/issues.type';
import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { IssueSource } from '@libs/issues/domain/interfaces/issues.interface';

import { IssuesRepository } from './issues.repository';

const exec = (value: unknown) => ({ exec: jest.fn(async () => value) });

/** An aggregation whose cursor yields these rows. */
const cursorOf = (rows: unknown[]) => {
    const query = {
        allowDiskUse: jest.fn(() => query),
        cursor: () =>
            (async function* () {
                yield* rows;
            })(),
    };
    return query;
};

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
        aggregate: jest.fn(() => cursorOf([])),
    };
}

describe('IssuesRepository — security-scan findings', () => {
    it('points a sighted issue at the commit the sighting scan read', async () => {
        const model = modelWith({
            _id: 'i-1',
            status: IssueStatus.OPEN,
            lastSeenCommitSha: 'old',
        });
        const repository = new IssuesRepository(model as any);

        await repository.upsertScanFinding({
            ...finding,
            lastSeenCommitSha: 'abc123',
        } as any);

        const [, update] = model.findOneAndUpdate.mock.calls[0] as unknown as [
            any,
            any,
        ];
        expect(update.$set.lastSeenCommitSha).toBe('abc123');
    });

    it('refreshes only while no other writer of this scan stored the identity first', async () => {
        const model = modelWith({
            _id: 'i-1',
            status: IssueStatus.OPEN,
            lastSeenScanId: 'scan-1',
        });
        const repository = new IssuesRepository(model as any);

        await repository.upsertScanFinding(finding);

        // The second writer of scan-2 finds lastSeenScanId moved and goes
        // round again, into the merge, instead of replacing the first's text.
        const [filter] = model.findOneAndUpdate.mock.calls[0] as unknown as [
            any,
            any,
        ];
        expect(filter).toEqual(
            expect.objectContaining({ lastSeenScanId: 'scan-1' }),
        );
    });

    it('keeps a holder as severe as its worst folded place when its own sighting is milder', async () => {
        const model = modelWith({
            _id: 'i-1',
            status: IssueStatus.OPEN,
            lastSeenScanId: 'scan-1',
            occurrences: [
                {
                    fingerprint: 'fp-a',
                    severity: 'critical',
                    filePath: 'src/a.ts',
                },
            ],
        });
        const repository = new IssuesRepository(model as any);

        await repository.upsertScanFinding({
            ...finding,
            severity: SeverityLevel.MEDIUM,
        } as any);

        const [, update] = model.findOneAndUpdate.mock.calls[0] as unknown as [
            any,
            any,
        ];
        expect(update.$set.severity).toBe('critical');
        // Its own place's severity is kept apart, for when that place leaves.
        expect(update.$set.ownSeverity).toBe('medium');
    });

    it('sights a folded duplicate a person reopened as its own issue, not on the holder', async () => {
        const model = modelWith({
            _id: 'i-a',
            fingerprint: 'fp-1',
            status: IssueStatus.OPEN,
            duplicateOf: 'fp-holder',
            lastSeenScanId: 'scan-1',
        });
        const repository = new IssuesRepository(model as any);

        const { outcome } = await repository.upsertScanFinding(finding);

        // Its own issue is refreshed with this scan's sighting, not merged
        // into the holder as one more place.
        expect(outcome).toBe('still_open');
        const [, update] = model.findOneAndUpdate.mock.calls[0] as unknown as [
            any,
            any,
        ];
        expect(update.$set.lastSeenScanId).toBe('scan-2');
        expect(update.$set.occurrences).toBeUndefined();
    });

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
                ownSeverity: finding.severity,
                contributingSuggestions: [],
                // Stored as the filter reads it, or the next sighting
                // would miss it.
                repository: expect.objectContaining({ host: '' }),
            }),
        );
        // The same id on another platform, or another instance of it, is
        // another repository.
        expect(model.findOne).toHaveBeenCalledWith({
            'organizationId': 'org-1',
            'repository.platform': PlatformType.GITHUB,
            'repository.host': '',
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
            lastSeenScanId: null,
            // Nor while a place was added since it was read.
            occurrences: { $in: [null, []] },
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
            'consecutiveScanMisses',
            'lastSeenAt',
            'lastSeenScanId',
        ]);
    });

    it('updates the issue another worker created first instead of failing', async () => {
        const model = modelWith(null);
        model.findOne
            .mockImplementationOnce(() => exec(null))
            // No issue holds it as a folded place.
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

    it('stores nothing twice when a unit run again stores the same finding in one scan', async () => {
        // The worker stopped between storing the finding and recording the
        // unit: the unit runs again and stores it again.
        const stored = {
            _id: 'i-1',
            status: IssueStatus.OPEN,
            lastSeenScanId: 'scan-2',
            title: finding.title,
            startLine: finding.startLine,
            endLine: finding.endLine,
            description: finding.description,
            severity: finding.severity,
        };
        const model = modelWith(stored);
        const repository = new IssuesRepository(model as any);

        const { outcome } = await repository.upsertScanFinding(finding);

        expect(outcome).toBe('still_open');
        const [, update] = model.findOneAndUpdate.mock.calls[0] as unknown as [
            any,
            any,
        ];
        expect(update.$set).toEqual({
            lastSeenAt: expect.any(String),
            consecutiveScanMisses: 0,
        });
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
        const [filter, update] = model.findOneAndUpdate.mock
            .calls[0] as unknown as [any, any];
        // Written only if no other occurrence landed since the read.
        expect(filter).toEqual({
            _id: 'i-1',
            status: IssueStatus.OPEN,
            description: 'Injection in the name filter.',
            occurrences: { $in: [null, []] },
        });
        expect(update.$set.description).toContain(
            'Injection in the name filter.',
        );
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
        const update = (
            model.findOneAndUpdate.mock.calls[0] as unknown as [any, any]
        )[1];
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
        'repository.platform': PlatformType.GITHUB,
        'repository.host': 'github.com',
        'repository.id': 'repo-1',
        'source': IssueSource.SECURITY_SCAN,
        'status': IssueStatus.OPEN,
        'lastSeenScanId': { $ne: 'scan-2' },
        // A newer, overlapping scan's sightings are not this one's to resolve.
        'lastSeenAt': { $lt: '2026-11-08T10:00:00.000Z' },
        'lastMissedScanId': { $ne: 'scan-2' },
    };

    it('resolves only open scan issues of a class in the files a lens of that class examined', async () => {
        const model = modelWith(null);
        const repository = new IssuesRepository(model as any);

        const resolved = await repository.resolveUnseenScanFindings({
            organizationId: 'org-1',
            repositoryPlatform: PlatformType.GITHUB,
            repositoryHost: 'github.com',
            repositoryId: 'repo-1',
            scanId: 'scan-2',
            // A scan may spell a path as it was found; the issue stores it clean.
            examined: [
                {
                    vulnerabilityClass: 'authz',
                    filePaths: ['./src/a.ts', 'src\\b.ts'],
                },
                { vulnerabilityClass: 'injection', filePaths: [] },
            ],
            scanStartedAt: '2026-11-08T10:00:00.000Z',
        });

        expect(resolved).toBe(3);
        const resolutions = model.updateMany.mock.calls.filter(
            (c: any) => !Array.isArray(c[1]),
        );
        expect((resolutions[0] as unknown[])[0]).toEqual({
            ...unseen,
            // An issue that still holds a place is not fixed.
            'occurrences.0': { $exists: false },
            'consecutiveScanMisses': { $gte: 1 },
            '$or': [
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
            repositoryPlatform: PlatformType.GITHUB,
            repositoryHost: 'github.com',
            repositoryId: 'repo-1',
            scanId: 'scan-2',
            examined: [],
            trackedFiles: ['./src/a.ts'],
            scanStartedAt: '2026-11-08T10:00:00.000Z',
        });

        expect(model.distinct).toHaveBeenCalledWith('filePath', unseen);
        // Not a model miss: no earlier miss is needed. (The other write
        // prunes the gone file's places from the issues that list them.)
        const resolutions = model.updateMany.mock.calls.filter(
            (c: any) => !Array.isArray(c[1]),
        );
        expect(resolutions).toHaveLength(1);
        expect((resolutions[0] as unknown[])[0]).toEqual({
            ...unseen,
            'occurrences.0': { $exists: false },
            'filePath': { $in: ['src/gone.ts'] },
        });
    });

    it('resolves nothing when the scan examined no file and read no file list', async () => {
        const model = modelWith(null);
        const repository = new IssuesRepository(model as any);

        await expect(
            repository.resolveUnseenScanFindings({
                organizationId: 'org-1',
                repositoryPlatform: PlatformType.GITHUB,
                repositoryHost: 'github.com',
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
            consecutiveScanMisses: 0,
        });
    });

    it('clears resolvedAt when an issue is moved out of resolved', async () => {
        const model = {
            updateMany: jest.fn(async (_filter: any, _update: any) => ({})),
            find: jest.fn(async () => []),
        };
        const repository = new IssuesRepository(model as any);

        await repository.updateStatusByIds(['i-1'], IssueStatus.OPEN);

        expect(model.updateMany.mock.calls[0][1]).toEqual({
            $set: { status: IssueStatus.OPEN, consecutiveScanMisses: 0 },
            $unset: { resolvedAt: '' },
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

describe('IssuesRepository.findOpenScanFindingAreas', () => {
    it("lists each file and class of the repository's open scan findings once", async () => {
        const find = jest.fn(() => ({
            lean: () =>
                exec([
                    { filePath: './src/a.ts', vulnerabilityClass: 'authz' },
                    { filePath: 'src/a.ts', vulnerabilityClass: 'authz' },
                    { filePath: 'src/a.ts', vulnerabilityClass: 'injection' },
                    { filePath: 'src/b.ts' },
                ]),
        }));
        const repository = new IssuesRepository({ find } as any);

        const areas = await repository.findOpenScanFindingAreas({
            organizationId: 'org-1',
            repositoryPlatform: PlatformType.GITLAB,
            repositoryHost: 'gitlab.com',
            repositoryId: 'repo-1',
        });

        expect(areas).toEqual([
            { filePath: 'src/a.ts', vulnerabilityClass: 'authz' },
            { filePath: 'src/a.ts', vulnerabilityClass: 'injection' },
        ]);
        const [filter] = find.mock.calls[0] as unknown as [any];
        expect(filter).toEqual({
            'organizationId': 'org-1',
            'repository.platform': PlatformType.GITLAB,
            'repository.host': 'gitlab.com',
            'repository.id': 'repo-1',
            'source': IssueSource.SECURITY_SCAN,
            'status': IssueStatus.OPEN,
        });
    });
});

describe('IssuesRepository.findOpenScanFindings', () => {
    it("lists the repository's open scan findings with what identifies each", async () => {
        const find = jest.fn(() => ({
            lean: () =>
                exec([
                    {
                        fingerprint: 'fp-dao',
                        filePath: './src/orders.dao.ts',
                        vulnerabilityClass: 'injection',
                        title: 'SQL built from the order id',
                        description: 'The id reaches the query.',
                        severity: 'high',
                        cwe: 'CWE-89',
                        startLine: 12,
                        endLine: 14,
                        evidence: {
                            attackPath: [
                                {
                                    file: 'src/orders.controller.ts',
                                    line: 5,
                                    note: 'id',
                                },
                            ],
                        },
                    },
                    // Stored before fingerprints: nothing to keep the identity of.
                    { filePath: 'src/old.ts', vulnerabilityClass: 'authz' },
                ]),
        }));
        const repository = new IssuesRepository({ find } as any);

        const open = await repository.findOpenScanFindings({
            organizationId: 'org-1',
            repositoryPlatform: PlatformType.GITLAB,
            repositoryHost: 'gitlab.com',
            repositoryId: 'repo-1',
        });

        expect(open).toEqual([
            {
                fingerprint: 'fp-dao',
                filePath: 'src/orders.dao.ts',
                vulnerabilityClass: 'injection',
                title: 'SQL built from the order id',
                description: 'The id reaches the query.',
                severity: 'high',
                cwe: 'CWE-89',
                startLine: 12,
                endLine: 14,
                attackPath: [
                    { file: 'src/orders.controller.ts', line: 5, note: 'id' },
                ],
            },
        ]);
        const [filter] = find.mock.calls[0] as unknown as [any];
        expect(filter).toEqual(
            expect.objectContaining({
                'repository.host': 'gitlab.com',
                'source': IssueSource.SECURITY_SCAN,
                'status': IssueStatus.OPEN,
            }),
        );
    });
});

describe('IssuesRepository.markScanFindingsSeen', () => {
    const scope = {
        organizationId: 'org-1',
        repositoryPlatform: PlatformType.GITHUB,
        repositoryHost: 'github.com',
        repositoryId: 'repo-1',
    };
    const identity = {
        'organizationId': 'org-1',
        'repository.platform': PlatformType.GITHUB,
        'repository.host': 'github.com',
        'repository.id': 'repo-1',
        'source': IssueSource.SECURITY_SCAN,
        'fingerprint': { $in: ['fp-1', 'fp-2'] },
    };

    it("marks the repository's open scan findings with these fingerprints as seen by the scan", async () => {
        const updateMany = jest.fn(async () => ({ modifiedCount: 2 }));
        const repository = new IssuesRepository({ updateMany } as any);

        const result = await repository.markScanFindingsSeen({
            ...scope,
            fingerprints: ['fp-1', 'fp-2', 'fp-1'],
            scanId: 'scan-2',
        });

        expect(result).toEqual({ sighted: 2, reopened: 0 });
        // Not found again: a resolved one stays resolved.
        expect(updateMany).toHaveBeenCalledTimes(2);
        const [filter, update] = updateMany.mock.calls[0] as unknown as [
            any,
            any,
        ];
        // Sighted once per scan: one it already sighted is not counted again.
        expect(filter).toEqual({
            ...identity,
            status: IssueStatus.OPEN,
            lastSeenScanId: { $ne: 'scan-2' },
        });
        expect(update.$set.lastSeenScanId).toBe('scan-2');
        expect(typeof update.$set.lastSeenAt).toBe('string');
        // A place an issue lists under one of them is seen too, not the
        // issue holding it.
        const [placeFilter, placeUpdate, placeOptions] = updateMany.mock
            .calls[1] as unknown as [any, any, any];
        const { fingerprint: _own, ...repositoryScope } = identity;
        expect(placeFilter).toEqual({
            ...repositoryScope,
            fingerprintAliases: { $in: ['fp-1', 'fp-2'] },
        });
        expect(placeUpdate).toEqual({
            $set: {
                'occurrences.$[o].lastSeenScanId': 'scan-2',
                'occurrences.$[o].lastSeenAt': update.$set.lastSeenAt,
            },
        });
        expect(placeOptions).toEqual({
            arrayFilters: [{ 'o.fingerprint': { $in: ['fp-1', 'fp-2'] } }],
        });
    });

    it('reopens a resolved one the scan found again, never a dismissed one', async () => {
        const updateMany = jest
            .fn()
            .mockResolvedValueOnce({ modifiedCount: 1 })
            .mockResolvedValueOnce({ modifiedCount: 0 })
            .mockResolvedValueOnce({ modifiedCount: 1 });
        const repository = new IssuesRepository({ updateMany } as any);

        const result = await repository.markScanFindingsSeen({
            ...scope,
            fingerprints: ['fp-1', 'fp-2'],
            scanId: 'scan-2',
            foundAgain: true,
        });

        expect(result).toEqual({ sighted: 1, reopened: 1 });
        const [filter, update] = updateMany.mock.calls[2] as unknown as [
            any,
            any,
        ];
        expect(filter).toEqual({ ...identity, status: IssueStatus.RESOLVED });
        expect(update.$set.status).toBe(IssueStatus.OPEN);
        // Seen by this scan, so its resolution pass does not close it again.
        expect(update.$set.lastSeenScanId).toBe('scan-2');
        expect(typeof update.$set.lastSeenAt).toBe('string');
        expect(update.$unset).toEqual({ resolvedAt: '' });
    });

    it('writes nothing without fingerprints', async () => {
        const updateMany = jest.fn();
        const repository = new IssuesRepository({ updateMany } as any);

        await expect(
            repository.markScanFindingsSeen({
                ...scope,
                fingerprints: [],
                scanId: 'scan-2',
            }),
        ).resolves.toEqual({ sighted: 0, reopened: 0 });
        expect(updateMany).not.toHaveBeenCalled();
    });
});

describe('pruning places a scan shows are gone', () => {
    it('drops places of a class read again without them, and places whose file left the branch', async () => {
        const updateMany = jest.fn(async () => ({ modifiedCount: 0 }));
        const distinct = jest.fn(() => exec([]));
        const places = cursorOf([
            { _id: 'src/orders/kept.ts' },
            { _id: 'src/gone.ts' },
        ]);
        const aggregate = jest.fn(() => places);
        const startedAt = '2026-11-25T00:00:00.000Z';
        const repository = new IssuesRepository({
            updateMany,
            distinct,
            aggregate,
        } as any);

        await repository.resolveUnseenScanFindings({
            organizationId: 'org-1',
            repositoryPlatform: PlatformType.GITHUB,
            repositoryHost: 'github.com',
            repositoryId: 'repo-1',
            scanId: 'scan-3',
            scanStartedAt: startedAt,
            trackedFiles: ['src/orders/kept.ts'],
            examined: [
                {
                    vulnerabilityClass: 'authz',
                    filePaths: ['src/orders/kept.ts'],
                },
            ],
        } as any);

        // Every prune write is held to this repository's open scan issues
        // that list a place it drops, and drops it in a pipeline that also
        // sets the severity back (its effect is pinned against a real
        // database in issues-scan-prune.repository.integration.spec.ts).
        const scope = {
            'organizationId': 'org-1',
            'repository.platform': PlatformType.GITHUB,
            'repository.host': 'github.com',
            'repository.id': 'repo-1',
            'source': IssueSource.SECURITY_SCAN,
            'status': IssueStatus.OPEN,
            'occurrences': { $exists: true, $ne: [] },
        };
        const pruneWrites = updateMany.mock.calls.filter((c: any) =>
            Array.isArray(c[1]),
        ) as any[];
        expect(pruneWrites.map(([filter]) => filter)).toEqual([
            {
                ...scope,
                occurrences: {
                    $elemMatch: {
                        filePath: { $in: ['src/gone.ts'] },
                        lastSeenAt: { $not: { $gte: startedAt } },
                    },
                },
            },
            {
                ...scope,
                occurrences: {
                    $elemMatch: {
                        vulnerabilityClass: 'authz',
                        filePath: { $in: ['src/orders/kept.ts'] },
                        lastSeenScanId: { $ne: 'scan-3' },
                        lastSeenAt: { $not: { $gte: startedAt } },
                    },
                },
            },
        ]);
        expect(pruneWrites.map(([, , options]) => options)).toEqual([
            { updatePipeline: true },
            { updatePipeline: true },
        ]);
        // A place a scan that overlapped this one saw after it started stays.
        const seenBefore = {
            $not: [{ $gte: ['$$o.lastSeenAt', startedAt] }],
        };
        expect(
            pruneWrites.map(([, pipeline]) => pipeline[0].$set.occurrences),
        ).toEqual([
            {
                $filter: {
                    input: '$occurrences',
                    as: 'o',
                    cond: {
                        $not: [
                            {
                                $and: [
                                    { $in: ['$$o.filePath', ['src/gone.ts']] },
                                    seenBefore,
                                ],
                            },
                        ],
                    },
                },
            },
            {
                $filter: {
                    input: '$occurrences',
                    as: 'o',
                    cond: {
                        $not: [
                            {
                                $and: [
                                    {
                                        $eq: [
                                            '$$o.vulnerabilityClass',
                                            'authz',
                                        ],
                                    },
                                    {
                                        $in: [
                                            '$$o.filePath',
                                            ['src/orders/kept.ts'],
                                        ],
                                    },
                                    { $ne: ['$$o.lastSeenScanId', 'scan-3'] },
                                    seenBefore,
                                ],
                            },
                        ],
                    },
                },
            },
        ]);
        // The places' paths, grouped where they can spill to disk.
        expect(aggregate).toHaveBeenCalledWith([
            { $match: scope },
            { $unwind: '$occurrences' },
            { $group: { _id: '$occurrences.filePath' } },
        ]);
        expect(places.allowDiskUse).toHaveBeenCalledWith(true);
    });
});

describe('single issue status transition', () => {
    it('records when a single issue is resolved', async () => {
        const findByIdAndUpdate = jest.fn(async () => null);
        const repository = new IssuesRepository({ findByIdAndUpdate } as any);

        await repository.updateStatus('issue-1', IssueStatus.RESOLVED);

        const [id, update, options] = findByIdAndUpdate.mock
            .calls[0] as unknown as [string, any, any];
        expect(id).toBe('issue-1');
        expect(update.$set).toEqual({
            status: IssueStatus.RESOLVED,
            resolvedAt: expect.any(String),
        });
        expect(Number.isFinite(Date.parse(update.$set.resolvedAt))).toBe(true);
        expect(update.$unset).toBeUndefined();
        expect(options).toEqual({ new: true });
    });

    it.each([IssueStatus.OPEN, IssueStatus.DISMISSED])(
        'clears resolvedAt when moving a single resolved issue to %s',
        async (status) => {
            const findByIdAndUpdate = jest.fn(async () => null);
            const repository = new IssuesRepository({
                findByIdAndUpdate,
            } as any);
            await repository.updateStatus('issue-1', status);
            expect(findByIdAndUpdate).toHaveBeenCalledWith(
                'issue-1',
                expect.objectContaining({
                    $set: expect.objectContaining({ status }),
                    $unset: { resolvedAt: '' },
                }),
                { new: true },
            );
        },
    );
});

describe('IssuesRepository — one issue per root cause', () => {
    const query = (value: unknown) => ({
        exec: jest.fn(async () => value),
        lean: () => ({ exec: jest.fn(async () => value) }),
    });
    const scope = {
        organizationId: 'org-1',
        repositoryPlatform: PlatformType.GITHUB,
        repositoryHost: '',
        repositoryId: 'repo-1',
    };
    const place = {
        fingerprint: 'fp-route',
        title: 'Route reaches the order with no owner check',
        cwe: 'CWE-862',
        filePath: 'src/orders/orders.routes.ts',
        startLine: 3,
        endLine: 3,
        severity: 'critical',
    };

    function modelOf(docs: Record<string, any>) {
        return {
            findOne: jest.fn((filter: any) =>
                query(docs[filter.fingerprint] ?? null),
            ),
            findOneAndUpdate: jest.fn(async (filter: any, update: any) => ({
                ...docs[
                    Object.keys(docs).find((k) => docs[k]._id === filter._id)!
                ],
                ...(update.$set ?? {}),
            })),
            updateOne: jest.fn(async () => ({
                matchedCount: 1,
                modifiedCount: 1,
            })),
            updateMany: jest.fn(async () => ({ modifiedCount: 1 })),
            create: jest.fn(),
        };
    }

    it('records a place of the same root cause on the issue that holds it, as seen', async () => {
        const model = modelOf({
            'fp-1': {
                _id: 'i-1',
                fingerprint: 'fp-1',
                status: IssueStatus.OPEN,
                severity: 'high',
            },
        });
        const repository = new IssuesRepository(model as any);

        const result = await repository.addScanFindingOccurrence({
            ...scope,
            holderFingerprint: 'fp-1',
            occurrence: place,
            scanId: 'scan-3',
        });

        expect(result?.outcome).toBe('merged');
        const [filter, update] = model.findOneAndUpdate.mock.calls[0] as any;
        // Only over the places and severities it worked from.
        expect(filter).toEqual({
            _id: 'i-1',
            status: IssueStatus.OPEN,
            occurrences: { $exists: false },
            severity: 'high',
            ownSeverity: { $exists: false },
        });
        expect(update.$set).toMatchObject({
            occurrences: [{ ...place, lastSeenScanId: 'scan-3' }],
            fingerprintAliases: ['fp-route'],
            severity: 'critical',
            // Stored before its own severity was kept: its severity is still
            // its own, kept before the place raises it.
            ownSeverity: 'high',
            lastSeenScanId: 'scan-3',
            consecutiveScanMisses: 0,
        });
    });

    it('replaces a place found again instead of listing it twice, and reopens a resolved issue', async () => {
        const model = modelOf({
            'fp-1': {
                _id: 'i-1',
                fingerprint: 'fp-1',
                status: IssueStatus.RESOLVED,
                severity: 'high',
                occurrences: [{ ...place, startLine: 1, endLine: 1 }],
                fingerprintAliases: ['fp-route'],
            },
        });
        const repository = new IssuesRepository(model as any);

        const result = await repository.addScanFindingOccurrence({
            ...scope,
            holderFingerprint: 'fp-1',
            occurrence: place,
            scanId: 'scan-3',
        });

        expect(result?.outcome).toBe('reopened');
        const [, update] = model.findOneAndUpdate.mock.calls[0] as any;
        expect(update.$set.occurrences).toHaveLength(1);
        expect(update.$set.occurrences[0].startLine).toBe(3);
        expect(update.$set.fingerprintAliases).toEqual(['fp-route']);
        expect(update.$set.status).toBe(IssueStatus.OPEN);
        expect(update.$unset).toEqual({ resolvedAt: '' });
    });

    it('follows an issue folded into another to the one that holds it', async () => {
        const model = modelOf({
            'fp-old': {
                _id: 'i-0',
                fingerprint: 'fp-old',
                status: IssueStatus.DISMISSED,
                duplicateOf: 'fp-1',
            },
            'fp-1': {
                _id: 'i-1',
                fingerprint: 'fp-1',
                status: IssueStatus.OPEN,
                severity: 'high',
            },
        });
        const repository = new IssuesRepository(model as any);

        await repository.addScanFindingOccurrence({
            ...scope,
            holderFingerprint: 'fp-old',
            occurrence: place,
            scanId: 'scan-3',
        });

        expect((model.findOneAndUpdate.mock.calls[0] as any)[0]._id).toBe(
            'i-1',
        );
    });

    it('stores a fresh finding at a folded place on the issue that holds it, never as a new issue', async () => {
        const holder = {
            _id: 'i-1',
            fingerprint: 'fp-1',
            status: IssueStatus.OPEN,
            severity: 'high',
        };
        const model = modelOf({ 'fp-1': holder });
        // Its own identity matches no issue; one issue lists it as a place.
        model.findOne.mockImplementation((filter: any) =>
            query(
                filter.fingerprintAliases === 'fp-route'
                    ? holder
                    : filter.fingerprint === 'fp-1'
                      ? holder
                      : null,
            ),
        );
        const repository = new IssuesRepository(model as any);

        const { outcome } = await repository.upsertScanFinding({
            ...finding,
            fingerprint: 'fp-route',
            lastSeenScanId: 'scan-3',
        } as any);

        expect(outcome).toBe('merged');
        expect(model.create).not.toHaveBeenCalled();
    });

    it('folds an issue into the one it shares a root cause with and dismisses it as a duplicate', async () => {
        const model = modelOf({
            'fp-dos': {
                _id: 'i-2',
                fingerprint: 'fp-dos',
                status: IssueStatus.OPEN,
                title: 'Unbounded login-init floods the store',
                cwe: 'CWE-400',
                filePath: 'src/cli/login.ts',
                startLine: 9,
                endLine: 12,
                severity: 'high',
                ownSeverity: 'medium',
                occurrences: [place],
            },
            'fp-1': {
                _id: 'i-1',
                fingerprint: 'fp-1',
                status: IssueStatus.OPEN,
                severity: 'medium',
            },
        });
        const repository = new IssuesRepository(model as any);

        const folded = await repository.foldScanIssueInto({
            ...scope,
            fingerprint: 'fp-dos',
            into: 'fp-1',
        });

        expect(folded).toBe(true);
        const [holderFilter, holderUpdate] = model.updateOne.mock
            .calls[0] as any;
        expect(holderFilter).toEqual({
            _id: 'i-1',
            occurrences: { $exists: false },
            severity: 'medium',
            ownSeverity: { $exists: false },
        });
        expect(holderUpdate.$set.fingerprintAliases).toEqual([
            'fp-dos',
            'fp-route',
        ]);
        expect(
            holderUpdate.$set.occurrences.map((o: any) => o.fingerprint),
        ).toEqual(['fp-dos', 'fp-route']);
        // The folded issue's place carries its own severity; its places
        // come along with theirs.
        expect(
            holderUpdate.$set.occurrences.map((o: any) => o.severity),
        ).toEqual(['medium', place.severity]);
        expect(holderUpdate.$set.severity).toBe('critical');
        // Kept across every place of the fold, not only the first.
        expect(holderUpdate.$set.ownSeverity).toBe('medium');
        const [foldedFilter, foldedUpdate] = model.updateOne.mock
            .calls[1] as any;
        expect(foldedFilter).toEqual({ _id: 'i-2', status: IssueStatus.OPEN });
        expect(foldedUpdate.$set).toMatchObject({
            status: IssueStatus.DISMISSED,
            duplicateOf: 'fp-1',
        });
    });

    const foldModel = () =>
        modelOf({
            'fp-dos': {
                _id: 'i-2',
                fingerprint: 'fp-dos',
                status: IssueStatus.OPEN,
                filePath: 'a.ts',
                severity: 'high',
            },
            'fp-1': {
                _id: 'i-1',
                fingerprint: 'fp-1',
                status: IssueStatus.OPEN,
                severity: 'high',
            },
        });

    it('dismisses the duplicate when the holder already lists its places from an earlier attempt', async () => {
        const model = foldModel();
        model.updateOne.mockResolvedValueOnce({
            matchedCount: 1,
            modifiedCount: 0,
        });
        const repository = new IssuesRepository(model as any);

        await expect(
            repository.foldScanIssueInto({
                ...scope,
                fingerprint: 'fp-dos',
                into: 'fp-1',
            }),
        ).resolves.toBe(true);
        expect(model.updateOne).toHaveBeenCalledTimes(2);
    });

    it('leaves the duplicate open when the holder changed since it was read', async () => {
        const model = foldModel();
        model.updateOne.mockResolvedValueOnce({
            matchedCount: 0,
            modifiedCount: 0,
        });
        const repository = new IssuesRepository(model as any);

        await expect(
            repository.foldScanIssueInto({
                ...scope,
                fingerprint: 'fp-dos',
                into: 'fp-1',
            }),
        ).resolves.toBe(false);
        expect(model.updateOne).toHaveBeenCalledTimes(1);
    });
});
