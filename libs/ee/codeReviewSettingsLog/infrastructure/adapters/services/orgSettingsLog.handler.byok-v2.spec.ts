import { OrgSettingsLogHandler } from './orgSettingsLog.handler';

/**
 * Who changed the BYOK keys, and to what.
 *
 * This handler diffs the saved config into `codeReviewSettingsLog` entries —
 * the audit trail for a setting that decides which vendor sees a customer's
 * source and which account pays for it. It read the legacy shape:
 *
 *     { main: { provider, model, apiKey, ... }, fallback: { ... } }
 *
 * BYOK moved to v2 on 2026-07-29 (migration ByokConfigV22026072918034700):
 *
 *     { version: 2, credentials: [...], models: [...], routing: {...} }
 *
 * `previous.main` and `current.main` are both undefined against a v2 blob, so
 * the diff loop found nothing to report and wrote no entry. The event still
 * fires, the handler still runs, and the collection simply stopped growing —
 * production's last BYOK audit row is dated 2026-07-16, two weeks before the
 * migration. An audit trail that goes quiet looks exactly like nobody touching
 * anything, which is the one thing it must never be confused with.
 */
const handler = Object.create(
    OrgSettingsLogHandler.prototype,
) as OrgSettingsLogHandler;

const byokChanges = (previous: unknown, current: unknown) =>
    (handler as never as {
        generateByokChanges: (
            p: unknown,
            c: unknown,
            email: string,
        ) => Array<{ actionDescription: string; description: string }>;
    }).generateByokChanges(previous, current, 'admin@kodus.io');

const v2 = (over: Record<string, unknown> = {}) => ({
    version: 2,
    credentials: [
        {
            id: 'cred-main',
            provider: 'openai',
            apiKey: 'ciphertext-a',
            settings: {},
        },
    ],
    models: [{ id: 'model-main', credentialId: 'cred-main', model: 'gpt-5.6' }],
    routing: { defaultModelId: 'model-main' },
    ...over,
});

describe('OrgSettingsLogHandler — BYOK audit trail on the v2 config shape', () => {
    it('reports the provider change a v2 blob describes', () => {
        const previous = v2();
        const current = v2({
            credentials: [
                {
                    id: 'cred-main',
                    provider: 'anthropic',
                    apiKey: 'ciphertext-a',
                    settings: {},
                },
            ],
        });

        const changes = byokChanges(previous, current);

        expect(changes).toHaveLength(1);
        expect(changes[0].actionDescription).toBe('BYOK Main Provider Updated');
        expect(changes[0].description).toContain('admin@kodus.io');
        expect(changes[0].description).toContain('anthropic');
    });

    it('reports the model change', () => {
        const current = v2({
            models: [
                {
                    id: 'model-main',
                    credentialId: 'cred-main',
                    model: 'claude-opus-5',
                },
            ],
        });

        const changes = byokChanges(v2(), current);

        expect(changes.map((c) => c.actionDescription)).toContain(
            'BYOK Main Model Updated',
        );
    });

    it('reports a fallback being added, keyed on routing — not array order', () => {
        // `models[1]` is not the fallback; `routing.fallbackModelId` is. An org
        // can carry a second model with no fallback selected, and that is not a
        // change to report.
        const current = v2({
            credentials: [
                {
                    id: 'cred-main',
                    provider: 'openai',
                    apiKey: 'ciphertext-a',
                    settings: {},
                },
                {
                    id: 'cred-fallback',
                    provider: 'anthropic',
                    apiKey: 'ciphertext-b',
                    settings: {},
                },
            ],
            models: [
                { id: 'model-main', credentialId: 'cred-main', model: 'gpt-5.6' },
                {
                    id: 'model-fallback',
                    credentialId: 'cred-fallback',
                    model: 'claude-opus-5',
                },
            ],
            routing: {
                defaultModelId: 'model-main',
                fallbackModelId: 'model-fallback',
            },
        });

        const changes = byokChanges(v2(), current);

        expect(changes.map((c) => c.actionDescription)).toContain(
            'BYOK Fallback Configuration Added',
        );
    });

    it('never writes the key on the add path, which dumps a whole slot', () => {
        // The field-by-field loop cannot reach `apiKey`, but "Configuration
        // Added" and "Configuration Removed" serialise the entire slot. Those
        // are the two places a key could escape into an audit document that is
        // read by people who are not the customer.
        const current = v2({
            credentials: [
                {
                    id: 'cred-main',
                    provider: 'openai',
                    apiKey: 'ciphertext-a',
                    settings: {},
                },
                {
                    id: 'cred-fallback',
                    provider: 'anthropic',
                    apiKey: 'sk-SECRET-FALLBACK',
                    settings: {},
                },
            ],
            models: [
                { id: 'model-main', credentialId: 'cred-main', model: 'gpt-5.6' },
                {
                    id: 'model-fallback',
                    credentialId: 'cred-fallback',
                    model: 'claude-opus-5',
                },
            ],
            routing: {
                defaultModelId: 'model-main',
                fallbackModelId: 'model-fallback',
            },
        });

        const added = byokChanges(v2(), current).find(
            (c) => c.actionDescription === 'BYOK Fallback Configuration Added',
        );

        const serialized = JSON.stringify(added);
        expect(serialized).not.toContain('sk-SECRET-FALLBACK');
        // Masked, not merely absent — a reader must be able to tell that a key
        // is set without being told what it is.
        expect((added as never as { currentValue: { apiKey: string } })
            .currentValue.apiKey).toBe('***');
    });

    it('never writes the key on the remove path either', () => {
        const previous = v2({
            credentials: [
                {
                    id: 'cred-main',
                    provider: 'openai',
                    apiKey: 'sk-SECRET-REMOVED',
                    settings: {},
                },
            ],
        });

        const removed = byokChanges(previous, {
            version: 2,
            credentials: [],
            models: [],
            routing: {},
        }).find(
            (c) => c.actionDescription === 'BYOK Main Configuration Removed',
        );

        expect(JSON.stringify(removed)).not.toContain('sk-SECRET-REMOVED');
        expect((removed as never as { previousValue: { apiKey: string } })
            .previousValue.apiKey).toBe('***');
    });

    it('does not report a second model that was never routed to', () => {
        const current = v2({
            models: [
                { id: 'model-main', credentialId: 'cred-main', model: 'gpt-5.6' },
                { id: 'spare', credentialId: 'cred-main', model: 'gpt-5.6-mini' },
            ],
        });

        expect(byokChanges(v2(), current)).toEqual([]);
    });

    it('reports a rotated API key without ever emitting the key', () => {
        const current = v2({
            credentials: [
                {
                    id: 'cred-main',
                    provider: 'openai',
                    apiKey: 'ciphertext-ROTATED',
                    settings: {},
                },
            ],
        });

        const changes = byokChanges(v2(), current);
        const serialized = JSON.stringify(changes);

        expect(changes.map((c) => c.actionDescription)).toContain(
            'BYOK Main API Key Updated',
        );
        expect(serialized).not.toContain('ciphertext-ROTATED');
        expect(serialized).not.toContain('ciphertext-a');
    });

    it('stays silent when nothing changed', () => {
        expect(byokChanges(v2(), v2())).toEqual([]);
    });

    it('still reads the legacy shape, for rows saved before the migration', () => {
        // The audit UI diffs historical entries too; a previousValue written
        // before 2026-07-29 is still v1.
        const changes = byokChanges(
            { main: { provider: 'openai', model: 'gpt-5.6', apiKey: 'x' } },
            { main: { provider: 'anthropic', model: 'gpt-5.6', apiKey: 'x' } },
        );

        expect(changes.map((c) => c.actionDescription)).toContain(
            'BYOK Main Provider Updated',
        );
    });
});
