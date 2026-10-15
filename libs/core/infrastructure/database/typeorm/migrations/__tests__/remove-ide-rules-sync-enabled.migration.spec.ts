import type { QueryRunner } from 'typeorm';

import { RemoveIdeRulesSyncEnabled2026101500000000 } from '../2026101500000000-RemoveIdeRulesSyncEnabled';

interface Row {
    uuid: string;
    configValue: Record<string, any> | null;
}

function makeQueryRunner(rows: Row[]) {
    const updates: string[] = [];
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
        if (/^\s*SELECT\s+uuid\s+FROM/i.test(sql)) {
            return rows
                .filter((r) =>
                    JSON.stringify(r.configValue ?? null).includes(
                        '"ideRulesSyncEnabled"',
                    ),
                )
                .map((r) => ({ uuid: r.uuid }));
        }
        if (/^\s*SELECT/i.test(sql)) {
            const row = rows.find((r) => r.uuid === params[0]);
            return row
                ? [{ configValue: structuredClone(row.configValue) }]
                : [];
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
    it('lists only the configs holding the key, in every stored version', async () => {
        const { queryRunner, query } = makeQueryRunner([]);

        await run(queryRunner);

        const [sql] = query.mock.calls[0];
        expect(sql).toMatch(/^\s*SELECT\s+uuid\s+FROM/i);
        expect(sql).toMatch(/"configKey"\s*=\s*'code_review_config'/);
        expect(sql).toMatch(/ideRulesSyncEnabled/);
        expect(sql).not.toMatch(/active/);
    });

    it('locks each row while it rewrites it, so a concurrent save is not overwritten', async () => {
        const { queryRunner, query } = makeQueryRunner([
            {
                uuid: 'team-a',
                configValue: { configs: { ideRulesSyncEnabled: true } },
            },
        ]);

        await run(queryRunner);

        const [readSql, readParams] = query.mock.calls[1];
        expect(readSql).toMatch(/FOR UPDATE/);
        expect(readParams).toEqual(['team-a']);
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
                            configs: {
                                ideRulesSyncEnabled: false,
                                runOnDraft: true,
                            },
                            directories: [
                                {
                                    id: 'd1',
                                    configs: { ideRulesSyncEnabled: true },
                                },
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

        const value = rows[0].configValue as Record<string, any>;
        expect(updates).toEqual(['team-a']);
        expect(value.configs).toEqual({ kodyRulesGeneratorEnabled: true });
        expect(value.repositories[0].configs).toEqual({ runOnDraft: true });
        expect(value.repositories[0].directories).toEqual([
            { id: 'd1', configs: {} },
            { id: 'd2' },
        ]);
        expect(value.repositories[1]).toEqual({ id: 'r2' });
    });

    it('skips scopes whose configs is not an object instead of failing the deploy', async () => {
        const rows: Row[] = [
            {
                uuid: 'team-odd',
                configValue: {
                    configs: 'ideRulesSyncEnabled',
                    repositories: [
                        { id: 'r1', configs: 7 },
                        { id: 'r2', configs: ['ideRulesSyncEnabled'] },
                        { id: 'r3', configs: { ideRulesSyncEnabled: true } },
                        { id: 'r4', directories: 'ideRulesSyncEnabled' },
                    ],
                },
            },
            {
                uuid: 'team-odd-repos',
                configValue: {
                    configs: { ideRulesSyncEnabled: true },
                    repositories: 'ideRulesSyncEnabled',
                },
            },
        ];
        const { queryRunner, updates } = makeQueryRunner(rows);

        await expect(run(queryRunner)).resolves.toBeUndefined();

        const value = rows[0].configValue as Record<string, any>;
        expect(updates).toEqual(['team-odd', 'team-odd-repos']);
        expect(value.configs).toBe('ideRulesSyncEnabled');
        expect(value.repositories[2].configs).toEqual({});
    });

    it('is idempotent', async () => {
        const rows: Row[] = [
            {
                uuid: 'team-b',
                configValue: { configs: { ideRulesSyncEnabled: true } },
            },
            { uuid: 'team-d', configValue: null },
        ];
        const first = makeQueryRunner(rows);
        await run(first.queryRunner);
        const second = makeQueryRunner(rows);
        await run(second.queryRunner);

        expect(first.updates).toEqual(['team-b']);
        expect(second.updates).toEqual([]);
    });
});
