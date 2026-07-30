import { KodyRulesRepository } from '@libs/ee/kodyRules/repository/kodyRules.repository';
import { KodyRulesSchema } from '@libs/kodyRules/infrastructure/adapters/repositories/schemas/kodyRules.model';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

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

    it('returns the aggregation result rows as-is', async () => {
        const rows = [
            { repositoryId: 'repo-1', directoryId: null, count: 3 },
            { repositoryId: 'repo-1', directoryId: 'dir-9', count: 1 },
        ];
        const { repo } = buildRepo(rows);

        const result = await repo.countRulesByRepository('org-1', statuses);

        expect(result).toEqual(rows);
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
