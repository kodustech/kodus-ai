import { ParametersRepository } from './parameters.repository';

/**
 * Regression coverage for the "duplicate key value violates unique
 * constraint UQ_parameters_one_active_per_team_key" prod incident
 * (BetterStack: 170+ occurrences over ~2 months, via
 * ParametersController.updateOrCreateCodeReviewParameter — the settings UI
 * save path, not just the background Kody Rules sync). Two concurrent
 * writers for the same (teamId, configKey) both deactivate the old active
 * row and then both try to insert their own new active row; the second
 * collides with the partial unique index.
 *
 * The fix takes a transaction-scoped Postgres advisory lock
 * (`pg_advisory_xact_lock`, auto-released on commit/rollback) keyed by
 * `${teamId}:${configKey}` BEFORE the deactivate/insert pair, so a second
 * concurrent writer for the same pair waits instead of racing into the
 * unique index.
 */
describe('ParametersRepository.createNewActiveVersion — serializes same-key writers', () => {
    const makeRepo = () => {
        const calls: string[] = [];
        const updateExecute = jest.fn().mockResolvedValue({ affected: 1 });
        const insertExecute = jest.fn().mockResolvedValue({});
        const findOne = jest.fn().mockResolvedValue({ uuid: 'new-uuid' });
        const query = jest.fn((sql: string) => {
            calls.push(`query(${sql})`);
            return Promise.resolve();
        });

        const updateQb: any = {
            update: jest.fn(() => updateQb),
            set: jest.fn(() => {
                calls.push('update.set');
                return updateQb;
            }),
            where: jest.fn(() => updateQb),
            andWhere: jest.fn(() => updateQb),
            execute: updateExecute,
        };
        const insertQb: any = {
            insert: jest.fn(() => insertQb),
            into: jest.fn(() => insertQb),
            values: jest.fn(() => {
                calls.push('insert.values');
                return insertQb;
            }),
            execute: insertExecute,
        };

        let cqbCallCount = 0;
        const manager = {
            query,
            createQueryBuilder: jest.fn(() => {
                cqbCallCount += 1;
                // First createQueryBuilder() call in the method is the
                // update, the second is the insert.
                return cqbCallCount === 1 ? updateQb : insertQb;
            }),
            findOne,
        };

        const parametersRepository = {
            manager: {
                transaction: jest.fn((cb: (m: unknown) => unknown) =>
                    cb(manager),
                ),
            },
        };

        const repo = new ParametersRepository(parametersRepository as any);
        return { repo, query, calls, updateExecute, insertExecute };
    };

    it('acquires a transaction-scoped advisory lock keyed by (teamId, configKey) before deactivating/inserting', async () => {
        const { repo, query, calls, updateExecute, insertExecute } = makeRepo();

        const result = await repo.createNewActiveVersion(
            'code_review_config' as any,
            'team-1',
            { foo: 'bar' } as any,
            2,
        );

        expect(result?.uuid).toBe('new-uuid');
        expect(query).toHaveBeenCalledWith(
            'SELECT pg_advisory_xact_lock(hashtext($1))',
            ['team-1:code_review_config'],
        );
        // Lock must be acquired BEFORE the deactivate/insert pair, not after.
        expect(calls).toEqual([
            'query(SELECT pg_advisory_xact_lock(hashtext($1)))',
            'update.set',
            'insert.values',
        ]);
        expect(updateExecute).toHaveBeenCalledTimes(1);
        expect(insertExecute).toHaveBeenCalledTimes(1);
    });

    it('uses a distinct lock key per (teamId, configKey) pair — different pairs never block each other', async () => {
        const { repo: repoA, query: queryA } = makeRepo();
        const { repo: repoB, query: queryB } = makeRepo();

        await repoA.createNewActiveVersion(
            'code_review_config' as any,
            'team-1',
            {} as any,
            1,
        );
        await repoB.createNewActiveVersion(
            'code_review_config' as any,
            'team-2',
            {} as any,
            1,
        );

        expect(queryA).toHaveBeenCalledWith(expect.any(String), [
            'team-1:code_review_config',
        ]);
        expect(queryB).toHaveBeenCalledWith(expect.any(String), [
            'team-2:code_review_config',
        ]);
    });
});
