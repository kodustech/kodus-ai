/**
 * Tests for the row-wise legacy→v2 BYOK migration (Phase 04b, plan 04b-07).
 *
 * Drives up()/down() against a MOCKED QueryRunner (in-memory rows — no real DB,
 * no Kodus-cloud dependency). Asserts: a legacy row becomes version:2, a
 * version===2 row is SKIPPED on a re-run (idempotent), the env-only self-host
 * path (no BYOK row) is untouched, and no plaintext key is ever logged.
 */
import type { QueryRunner } from 'typeorm';
import { encrypt } from '@libs/common/utils/crypto';
import { ByokConfigV22026072918034700 } from './2026072918034700-ByokConfigV2';
import { isV2Config } from '@libs/llm/byok-config';

const BYOK_CONFIG_KEY = 'byok_config';

interface Row {
    uuid: string;
    configKey: string;
    configValue: unknown;
}

/**
 * A minimal in-memory QueryRunner: understands the two statements the migration
 * issues (SELECT the BYOK rows, UPDATE one row's configValue). jsonb is returned
 * parsed (like node-postgres) and written parsed back into the store.
 */
function makeQueryRunner(rows: Row[]) {
    const store = rows;
    const updates: Array<{ uuid: string; value: unknown }> = [];
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
        if (/^\s*SELECT/i.test(sql)) {
            return store
                .filter((r) => r.configKey === params[0])
                .map((r) => ({ uuid: r.uuid, configValue: r.configValue }));
        }
        if (/^\s*UPDATE/i.test(sql)) {
            const [rawValue, uuid] = params as [unknown, string];
            const value =
                typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
            const row = store.find((r) => r.uuid === uuid);
            if (row) row.configValue = value;
            updates.push({ uuid, value });
            return [];
        }
        return [];
    });
    const queryRunner = { query } as unknown as QueryRunner;
    return { queryRunner, store, updates, query };
}

function legacyRow(uuid: string): Row {
    return {
        uuid,
        configKey: BYOK_CONFIG_KEY,
        configValue: {
            main: {
                provider: 'openai',
                apiKey: encrypt('sk-plaintext'),
                model: 'gpt-4o',
            },
        },
    };
}

describe('ByokConfigV2 migration', () => {
    it('up(): a legacy BYOK row is rewritten to version:2', async () => {
        const { queryRunner, store, updates } = makeQueryRunner([
            legacyRow('org-1'),
        ]);

        await new ByokConfigV22026072918034700().up(queryRunner);

        expect(updates).toHaveLength(1);
        expect(isV2Config(store[0].configValue)).toBe(true);
        expect((store[0].configValue as any).version).toBe(2);
    });

    it('up(): a version===2 row is SKIPPED — idempotent re-run is a no-op', async () => {
        const { queryRunner, updates } = makeQueryRunner([legacyRow('org-1')]);
        const migration = new ByokConfigV22026072918034700();

        await migration.up(queryRunner); // first run migrates
        expect(updates).toHaveLength(1);

        await migration.up(queryRunner); // second run: already v2 → skip
        expect(updates).toHaveLength(1); // no additional UPDATE
    });

    it('up(): env-only self-host path (no BYOK row) is untouched', async () => {
        const { queryRunner, updates } = makeQueryRunner([]);
        await new ByokConfigV22026072918034700().up(queryRunner);
        expect(updates).toHaveLength(0);
    });

    it('up(): ciphertext is carried VERBATIM (no re-encrypt) into the v2 credential', async () => {
        const row = legacyRow('org-1');
        const originalKey = (row.configValue as any).main.apiKey;
        const { queryRunner, store } = makeQueryRunner([row]);

        await new ByokConfigV22026072918034700().up(queryRunner);

        const v2 = store[0].configValue as any;
        expect(v2.credentials[0].apiKey).toBe(originalKey);
    });

    it('down(): best-effort re-expands a v2 row toward {main,fallback}', async () => {
        const v2Row: Row = {
            uuid: 'org-1',
            configKey: BYOK_CONFIG_KEY,
            configValue: {
                version: 2,
                credentials: [
                    { id: 'cred-main', provider: 'openai', apiKey: 'ct-main' },
                ],
                models: [
                    { id: 'model-main', credentialId: 'cred-main', model: 'gpt-4o' },
                ],
                routing: { defaultModelId: 'model-main' },
            },
        };
        const { queryRunner, store } = makeQueryRunner([v2Row]);

        await new ByokConfigV22026072918034700().down(queryRunner);

        const reverted = store[0].configValue as any;
        expect(reverted.main?.provider).toBe('openai');
        expect(reverted.main?.model).toBe('gpt-4o');
        expect(reverted.main?.apiKey).toBe('ct-main'); // ciphertext verbatim
    });

    it('emits NO plaintext key material to any console channel', async () => {
        const plaintext = 'super-secret-migration-plaintext';
        const row: Row = {
            uuid: 'org-1',
            configKey: BYOK_CONFIG_KEY,
            configValue: {
                main: {
                    provider: 'openai',
                    apiKey: encrypt(plaintext),
                    model: 'gpt-4o',
                },
                fallback: {
                    provider: 'openai',
                    apiKey: encrypt(plaintext), // same key → dedup decrypt path
                    model: 'gpt-4o-mini',
                },
            },
        };
        const { queryRunner } = makeQueryRunner([row]);
        const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
            (m) => jest.spyOn(console, m).mockImplementation(() => {}),
        );

        try {
            await new ByokConfigV22026072918034700().up(queryRunner);
            for (const spy of spies) {
                for (const call of spy.mock.calls) {
                    expect(JSON.stringify(call)).not.toContain(plaintext);
                }
            }
        } finally {
            spies.forEach((s) => s.mockRestore());
        }
    });
});
