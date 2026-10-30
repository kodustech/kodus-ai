import { KodyRulesRepository } from './kodyRules.repository';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { KodyRulesSchema } from '@libs/kodyRules/infrastructure/adapters/repositories/schemas/kodyRules.model';

describe('KodyRulesRepository.findById organization isolation', () => {
    it('restricts the document match to the requested organization', async () => {
        const aggregate = jest
            .fn()
            .mockReturnValue({ exec: jest.fn().mockResolvedValue([]) });
        const repo = new KodyRulesRepository({ aggregate } as any, {} as any);

        await expect(
            repo.findById('foreign-rule', 'org-own'),
        ).resolves.toBeNull();
        expect(aggregate.mock.calls[0][0][0]).toEqual({
            $match: {
                'organizationId': 'org-own',
                'rules.uuid': 'foreign-rule',
            },
        });
    });

    it('never drops the organization filter, even for an empty id', async () => {
        const aggregate = jest
            .fn()
            .mockReturnValue({ exec: jest.fn().mockResolvedValue([]) });
        const repo = new KodyRulesRepository({ aggregate } as any, {} as any);

        await expect(repo.findById('rule-own', '')).resolves.toBeNull();
        expect(aggregate.mock.calls[0][0][0]).toEqual({
            $match: { 'organizationId': '', 'rules.uuid': 'rule-own' },
        });
    });
});

/**
 * Regression coverage for the bulk-cleanup bug: the "Reset integration and
 * remove repositories config" flow used to leave directory-scoped and
 * non-ACTIVE rules behind because the Mongo filter forced
 * `rules.directoryId: null` and `elem.status: ACTIVE`. These tests pin the
 * fix: directoryId === undefined must match every rule under the repo, and
 * any non-DELETED status must be eligible for the bulk transition.
 */
describe('KodyRulesRepository.updateRulesStatusByFilter', () => {
    let model: any;
    let repo: KodyRulesRepository;
    let findOneAndUpdate: jest.Mock;
    let exec: jest.Mock;

    beforeEach(() => {
        exec = jest.fn().mockResolvedValue(null);
        findOneAndUpdate = jest.fn().mockReturnValue({ exec });
        model = { findOneAndUpdate };

        repo = new KodyRulesRepository(model as any, {} as any);
    });

    describe('directoryId === undefined (bulk repo cleanup)', () => {
        it('does not constrain on rules.directoryId in the doc filter', async () => {
            await repo.updateRulesStatusByFilter('org-1', 'repo-1');

            const [filter] = findOneAndUpdate.mock.calls[0];
            expect(filter.organizationId).toBe('org-1');
            expect(filter['rules.repositoryId']).toBe('repo-1');
            expect(filter).not.toHaveProperty('rules.directoryId');
        });

        it('does not constrain on elem.directoryId in arrayFilters', async () => {
            await repo.updateRulesStatusByFilter('org-1', 'repo-1');

            const [, , options] = findOneAndUpdate.mock.calls[0];
            const [arrayFilter] = options.arrayFilters;
            expect(arrayFilter['elem.repositoryId']).toBe('repo-1');
            expect(arrayFilter).not.toHaveProperty('elem.directoryId');
        });

        it('matches every non-DELETED status (not just ACTIVE)', async () => {
            await repo.updateRulesStatusByFilter('org-1', 'repo-1');

            const [, , options] = findOneAndUpdate.mock.calls[0];
            const [arrayFilter] = options.arrayFilters;
            expect(arrayFilter['elem.status']).toEqual({
                $ne: KodyRulesStatus.DELETED,
            });
        });

        it('defaults newStatus to DELETED', async () => {
            await repo.updateRulesStatusByFilter('org-1', 'repo-1');

            const [, update] = findOneAndUpdate.mock.calls[0];
            expect(update.$set['rules.$[elem].status']).toBe(
                KodyRulesStatus.DELETED,
            );
        });
    });

    describe('directoryId provided (per-directory cleanup)', () => {
        it('constrains both doc filter and arrayFilters on the directoryId', async () => {
            await repo.updateRulesStatusByFilter('org-1', 'repo-1', 'dir-9');

            const [filter, , options] = findOneAndUpdate.mock.calls[0];
            expect(filter['rules.directoryId']).toBe('dir-9');

            const [arrayFilter] = options.arrayFilters;
            expect(arrayFilter['elem.directoryId']).toBe('dir-9');
            expect(arrayFilter['elem.status']).toEqual({
                $ne: KodyRulesStatus.DELETED,
            });
        });
    });

    it('honors a custom newStatus when provided', async () => {
        await repo.updateRulesStatusByFilter(
            'org-1',
            'repo-1',
            undefined,
            KodyRulesStatus.PAUSED,
        );

        const [, update] = findOneAndUpdate.mock.calls[0];
        expect(update.$set['rules.$[elem].status']).toBe(
            KodyRulesStatus.PAUSED,
        );
    });
});

describe('KodyRulesRepository.updateRule — clearing a field', () => {
    function build() {
        const exec = jest.fn().mockResolvedValue(null);
        const findOneAndUpdate = jest.fn().mockReturnValue({ exec });
        const findOne = jest.fn().mockReturnValue({ exec });
        const repo = new KodyRulesRepository(
            { findOneAndUpdate, findOne } as any,
            {} as any,
        );
        return { repo, findOneAndUpdate };
    }

    it('writes null, which clears the stored value', async () => {
        const { repo, findOneAndUpdate } = build();

        await repo.updateRule('doc-1', 'rule-1', { contextReferenceId: null });

        const [, update] = findOneAndUpdate.mock.calls[0];
        expect(update.$set).toEqual({ 'rules.$.contextReferenceId': null });
    });
});

describe('KodyRulesRepository.markAutoPausesDigested', () => {
    it('marks only the pause records that still carry the digested pausedAt', async () => {
        const exec = jest.fn().mockResolvedValue({ modifiedCount: 1 });
        const updateOne = jest.fn().mockReturnValue({ exec });
        const repo = new KodyRulesRepository({ updateOne } as any, {} as any);
        const pausedAt = new Date('2026-10-21T06:00:00Z');
        const digestedAt = new Date('2026-10-26T09:00:00Z');

        await expect(
            repo.markAutoPausesDigested(
                'org-1',
                'rule-1',
                [pausedAt],
                digestedAt,
            ),
        ).resolves.toBe(true);

        expect(updateOne).toHaveBeenCalledWith(
            { organizationId: 'org-1' },
            {
                $set: {
                    'rules.$[current].autoPause.digestedAt': digestedAt,
                    'rules.$[previous].lastAutoPause.digestedAt': digestedAt,
                },
            },
            {
                arrayFilters: [
                    {
                        'current.uuid': 'rule-1',
                        'current.autoPause.pausedAt': { $in: [pausedAt] },
                    },
                    {
                        'previous.uuid': 'rule-1',
                        'previous.lastAutoPause.pausedAt': { $in: [pausedAt] },
                    },
                ],
            },
        );
    });

    it('reports false when nothing matched', async () => {
        const exec = jest.fn().mockResolvedValue({ modifiedCount: 0 });
        const repo = new KodyRulesRepository(
            { updateOne: jest.fn().mockReturnValue({ exec }) } as any,
            {} as any,
        );

        await expect(
            repo.markAutoPausesDigested(
                'org-1',
                'rule-1',
                [new Date()],
                new Date(),
            ),
        ).resolves.toBe(false);
    });
});

describe('KodyRulesModel schema indexes', () => {
    // findById() looks rules up by embedded `rules.uuid` with no org prefix;
    // without this multikey index it is a full collection scan across every
    // org's document. Guard against the index being dropped.
    it('declares a multikey index on rules.uuid', () => {
        const indexes = KodyRulesSchema.indexes();
        const hasRulesUuidIndex = indexes.some(
            ([fields]: [Record<string, unknown>, unknown]) =>
                fields && fields['rules.uuid'] === 1,
        );
        expect(hasRulesUuidIndex).toBe(true);
    });
});

describe('KodyRulesRepository.countRulesByRepository', () => {
    const buildRepo = (aggregateResult: unknown[]) => {
        const exec = jest.fn().mockResolvedValue(aggregateResult);
        const aggregate = jest.fn().mockReturnValue({ exec });
        const modelMock = { aggregate } as any;
        const repo = new KodyRulesRepository(modelMock, {} as any);
        return { repo, aggregate, exec };
    };

    const statuses = [KodyRulesStatus.ACTIVE, KodyRulesStatus.PAUSED];

    it('builds an aggregation that scopes by org, filters status, and groups by (repo, dir)', async () => {
        const { repo, aggregate } = buildRepo([]);

        await repo.countRulesByRepository('org-1', statuses);

        const pipeline = aggregate.mock.calls[0][0];

        // Scoped to the org first (uses the organizationId index).
        expect(pipeline[0]).toEqual({ $match: { organizationId: 'org-1' } });

        // Unwinds the embedded array.
        expect(pipeline).toContainEqual({ $unwind: '$rules' });

        // Keeps only the requested statuses (ACTIVE + PAUSED here).
        expect(pipeline).toContainEqual({
            $match: { 'rules.status': { $in: statuses } },
        });

        // Groups by repository AND directory so repo-level and directory-level
        // counts stay distinct.
        const group = pipeline.find((stage: any) => stage.$group);
        expect(group.$group._id).toEqual({
            repositoryId: '$rules.repositoryId',
            directoryId: '$rules.directoryId',
        });
        expect(group.$group.count).toEqual({ $sum: 1 });
    });
});

describe('KodyRulesRepository.updateRule (field-level merge)', () => {
    const buildRepo = () => {
        const exec = jest.fn().mockResolvedValue(null);
        const findOneAndUpdate = jest.fn().mockReturnValue({ exec });
        const findOne = jest.fn().mockReturnValue({ exec });
        const modelMock = { findOneAndUpdate, findOne } as any;
        const repo = new KodyRulesRepository(modelMock, {} as any);
        return { repo, findOneAndUpdate, findOne };
    };

    it('sets each field under rules.$.<field>, not the whole element', async () => {
        const { repo, findOneAndUpdate } = buildRepo();

        await repo.updateRule('doc-1', 'rule-1', {
            title: 'New title',
            severity: 'high',
        } as any);

        const [filter, update] = findOneAndUpdate.mock.calls[0];
        expect(filter).toEqual({ '_id': 'doc-1', 'rules.uuid': 'rule-1' });
        // Per-field $set — NOT { 'rules.$': {...} } which would wipe omitted fields.
        expect(update).toEqual({
            $set: {
                'rules.$.title': 'New title',
                'rules.$.severity': 'high',
            },
        });
    });

    it('omits undefined fields from the $set', async () => {
        const { repo, findOneAndUpdate } = buildRepo();

        await repo.updateRule('doc-1', 'rule-1', {
            title: 'Only title',
            severity: undefined,
            path: undefined,
        } as any);

        const [, update] = findOneAndUpdate.mock.calls[0];
        expect(update).toEqual({ $set: { 'rules.$.title': 'Only title' } });
    });

    it('does not issue an empty $set when the patch has no concrete fields', async () => {
        const { repo, findOneAndUpdate, findOne } = buildRepo();

        await repo.updateRule('doc-1', 'rule-1', {
            severity: undefined,
        } as any);

        // Empty $set is rejected by Mongo — must fall back to a read.
        expect(findOneAndUpdate).not.toHaveBeenCalled();
        expect(findOne).toHaveBeenCalledWith({
            '_id': 'doc-1',
            'rules.uuid': 'rule-1',
        });
    });
});
