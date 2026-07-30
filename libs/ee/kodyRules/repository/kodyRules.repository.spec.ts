import { KodyRulesRepository } from './kodyRules.repository';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

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
