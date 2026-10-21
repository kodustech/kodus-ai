import type { QueryRunner } from 'typeorm';

import { PinIdeRulesSyncUnderGlobalOn2026100500000000 } from '../2026100500000000-PinIdeRulesSyncUnderGlobalOn';

interface Row {
    uuid: string;
    configValue: Record<string, any>;
}

function makeQueryRunner(rows: Row[]) {
    const updates: Array<{ uuid: string; value: any }> = [];
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
        if (/^\s*SELECT/i.test(sql)) {
            return rows.map((r) => ({
                uuid: r.uuid,
                configValue: structuredClone(r.configValue),
            }));
        }
        if (/^\s*UPDATE/i.test(sql)) {
            const [rawValue, uuid] = params as [string, string];
            const value = JSON.parse(rawValue);
            const row = rows.find((r) => r.uuid === uuid);
            if (row) row.configValue = value;
            updates.push({ uuid, value });
        }
        return [];
    });
    return {
        queryRunner: { query } as unknown as QueryRunner,
        updates,
        query,
    };
}

const run = (queryRunner: QueryRunner) =>
    new PinIdeRulesSyncUnderGlobalOn2026100500000000().up(queryRunner);

describe('PinIdeRulesSyncUnderGlobalOn migration', () => {
    it('only reads the active code review configs', async () => {
        const { queryRunner, query } = makeQueryRunner([]);

        await run(queryRunner);

        const [sql] = query.mock.calls[0];
        expect(sql).toMatch(/"configKey"\s*=\s*'code_review_config'/);
        expect(sql).toMatch(/active\s*=\s*true/);
    });

    it('never touches the generator setting', async () => {
        const rows: Row[] = [
            {
                uuid: 'team-a',
                configValue: {
                    configs: { automatedReviewActive: true },
                    repositories: [{ id: 'r1', configs: {} }],
                },
            },
        ];
        const { queryRunner, updates } = makeQueryRunner(rows);

        await run(queryRunner);

        expect(updates).toEqual([]);
        expect(rows[0].configValue.configs).toEqual({
            automatedReviewActive: true,
        });
    });

    it('pins IDE sync off on repositories that would start inheriting a global "on"', async () => {
        const rows: Row[] = [
            {
                uuid: 'team-ide',
                configValue: {
                    configs: { ideRulesSyncEnabled: true },
                    repositories: [
                        { id: 'inherits', configs: {} },
                        { id: 'no-configs' },
                        {
                            id: 'own-on',
                            configs: { ideRulesSyncEnabled: true },
                        },
                        {
                            id: 'with-dir',
                            configs: {},
                            directories: [
                                {
                                    id: 'd1',
                                    configs: { ideRulesSyncEnabled: true },
                                },
                            ],
                        },
                    ],
                },
            },
        ];
        const { queryRunner } = makeQueryRunner(rows);

        await run(queryRunner);

        const repos = rows[0].configValue.repositories;
        expect(repos[0].configs).toEqual({ ideRulesSyncEnabled: false });
        expect(repos[1].configs).toEqual({ ideRulesSyncEnabled: false });
        expect(repos[2].configs).toEqual({ ideRulesSyncEnabled: true });
        expect(repos[3].configs).toEqual({ ideRulesSyncEnabled: false });
        expect(repos[3].directories[0].configs).toEqual({
            ideRulesSyncEnabled: true,
        });
    });

    it('leaves repositories alone when global IDE sync is not on', async () => {
        const rows: Row[] = [
            {
                uuid: 'team-default',
                configValue: {
                    configs: {},
                    repositories: [{ id: 'r1', configs: {} }],
                },
            },
        ];
        const { queryRunner, updates } = makeQueryRunner(rows);

        await run(queryRunner);

        expect(updates).toEqual([]);
    });

    it('changes nothing on a second run', async () => {
        const rows: Row[] = [
            {
                uuid: 'team-a',
                configValue: {
                    configs: { ideRulesSyncEnabled: true },
                    repositories: [{ id: 'r1', configs: {} }],
                },
            },
        ];
        const first = makeQueryRunner(rows);
        await run(first.queryRunner);
        expect(first.updates).toHaveLength(1);

        const second = makeQueryRunner(rows);
        await run(second.queryRunner);
        expect(second.updates).toEqual([]);
    });
});
