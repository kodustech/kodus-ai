import type { QueryRunner } from 'typeorm';

import { RemoveIdeRulesSyncEnabled2026101500000000 } from '../2026101500000000-RemoveIdeRulesSyncEnabled';

interface Row {
    uuid: string;
    configValue: Record<string, any>;
}

function makeQueryRunner(rows: Row[]) {
    const updates: string[] = [];
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
        if (/^\s*SELECT/i.test(sql)) {
            return rows.map((r) => ({
                uuid: r.uuid,
                configValue: structuredClone(r.configValue),
            }));
        }
        if (/^\s*UPDATE/i.test(sql)) {
            const [rawValue, uuid] = params as [string, string];
            const row = rows.find((r) => r.uuid === uuid);
            if (row) row.configValue = JSON.parse(rawValue);
            updates.push(uuid);
        }
        return [];
    });
    return { queryRunner: { query } as unknown as QueryRunner, updates, query };
}

const run = (queryRunner: QueryRunner) =>
    new RemoveIdeRulesSyncEnabled2026101500000000().up(queryRunner);

describe('RemoveIdeRulesSyncEnabled migration', () => {
    it('reads every code review config version, not only the active one', async () => {
        const { queryRunner, query } = makeQueryRunner([]);

        await run(queryRunner);

        const [sql] = query.mock.calls[0];
        expect(sql).toMatch(/"configKey"\s*=\s*'code_review_config'/);
        expect(sql).not.toMatch(/active/);
    });

    it('removes the key at global, repository and directory level, and nothing else', async () => {
        const rows: Row[] = [
            {
                uuid: 'team-a',
                configValue: {
                    configs: {
                        ideRulesSyncEnabled: true,
                        kodyRulesGeneratorEnabled: true,
                    },
                    repositories: [
                        {
                            id: 'r1',
                            configs: { ideRulesSyncEnabled: false, runOnDraft: true },
                            directories: [
                                { id: 'd1', configs: { ideRulesSyncEnabled: true } },
                                { id: 'd2' },
                            ],
                        },
                        { id: 'r2' },
                    ],
                },
            },
        ];
        const { queryRunner, updates } = makeQueryRunner(rows);

        await run(queryRunner);

        const value = rows[0].configValue;
        expect(updates).toEqual(['team-a']);
        expect(value.configs).toEqual({ kodyRulesGeneratorEnabled: true });
        expect(value.repositories[0].configs).toEqual({ runOnDraft: true });
        expect(value.repositories[0].directories).toEqual([
            { id: 'd1', configs: {} },
            { id: 'd2' },
        ]);
        expect(value.repositories[1]).toEqual({ id: 'r2' });
    });

    it('writes nothing for a config without the key, and is idempotent', async () => {
        const rows: Row[] = [
            {
                uuid: 'team-b',
                configValue: {
                    configs: { ideRulesSyncEnabled: true },
                    repositories: [],
                },
            },
            { uuid: 'team-c', configValue: { configs: {}, repositories: [] } },
            { uuid: 'team-d', configValue: null as any },
        ];
        const first = makeQueryRunner(rows);
        await run(first.queryRunner);
        const second = makeQueryRunner(rows);
        await run(second.queryRunner);

        expect(first.updates).toEqual(['team-b']);
        expect(second.updates).toEqual([]);
    });
});
