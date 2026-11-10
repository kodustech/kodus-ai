import { randomUUID } from 'crypto';
import { decodeFrame, PROTOCOL_VERSION } from '@libs/runtime/protocol';
import { InMemoryRunStreamStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';
import { createCa } from '../ca/x509';
import { CellHub } from '../cell-hub';
import { InMemoryHubStore } from '../hub-store';
import { claimIdFor } from './claim.service';

const CELL = 'cell-recipe';
const SHA = 'a'.repeat(40);
const manifest = {
    services: [{ name: 'web', health: 'ok' }],
    expose: [{ service: 'web', port: 3000, kind: 'http' }],
    imageId: 'img',
    seedSha: 'seed',
};
const frame = (
    type: string,
    body: unknown,
    extra: Record<string, unknown> = {},
) =>
    JSON.stringify({
        v: PROTOCOL_VERSION,
        id: randomUUID(),
        cellId: CELL,
        type,
        body,
        ...extra,
    });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const fakes = 'version: 1\nfakes: { stripe: { image: stripe-mock } }\n';
const sql =
    'version: 1\nservices:\n  expose: [{ service: db, port: 5432, kind: postgres, readonly_user_from_seed: true }]\ndata:\n  seed: {service: db, user: shop, database: shop, sql: seed.sql}\n';

async function acquire(content: string | null, features: string[] = []) {
    const store = new InMemoryHubStore();
    const hub = new CellHub(
        store,
        new InMemoryRunStreamStore(),
        new RuntimeMetrics(),
        {
            replicaId: 'recipe-test',
            replicaUrl: 'http://hub',
            ca: createCa('recipe-test-ca'),
            log: () => undefined,
        },
    );
    const sent: any[] = [];
    const conn = hub.attach(
        {
            send(raw: string) {
                const parsed = decodeFrame(raw);
                if ('code' in parsed) throw new Error(parsed.code);
                sent.push(parsed.message);
            },
            close() {},
        },
        { cellId: CELL, owner: 'kodus' },
    );
    await conn.onMessage(
        frame('hello', {
            versions: [1],
            driver: 'fake',
            isolation: 'vm',
            regions: ['local'],
            owner: 'kodus',
            features,
        }),
    );
    const pending = hub.acquire(CELL, {
        organizationId: 'org',
        environmentId: 'env',
        runId: 'run',
        imageId: 'img',
        ref: { side: 'base', sha: SHA },
        consumer: 'runtime',
        idempotencyKey: 'run:base:1',
        expose: manifest.expose as any,
        repo: {
            provider: 'github',
            fullName: 'acme/shop',
            apiBase: 'https://api.github.com',
        },
        repoToken: 'fixture-token',
        recipe: { path: '.kodus/workspace.yaml', content },
    });
    for (let i = 0; i < 8; i++) await tick();
    const req = sent.find((message) => message.type === 'claim.acquire');
    if (req) {
        await conn.onMessage(frame('ack', {}, { re: req.id }));
        await conn.onMessage(
            frame(
                'claim.ready',
                { manifest, observer: { id: 'observer', state: 'ready' } },
                { claimId: req.claimId },
            ),
        );
    }
    const result = await pending;
    return { result, sent, store, hub, conn };
}

describe('declared recipe execution capabilities (#2493/#2494)', () => {
    it.each([
        [fakes, 'recipeFakes'],
        [sql, 'seededSQL'],
    ])(
        'an older cell cannot silently ignore recipe requirements',
        async (content, feature) => {
            const t = await acquire(content);
            expect(t.result).toMatchObject({
                status: 'blocked',
                blockers: [
                    {
                        kind: 'platform',
                        signature: 'recipe_capability_unsupported',
                    },
                ],
            });
            expect(
                t.sent.filter((m) => m.type === 'claim.acquire'),
            ).toHaveLength(0);
            expect(
                await t.store.claim(claimIdFor('org', 'run:base:1')),
            ).toBeNull();
            expect(JSON.stringify(t.result)).toContain(feature);
            await t.conn.onClose();
        },
    );
    it.each([
        [fakes, 'recipeFakes'],
        [sql, 'seededSQL'],
    ])(
        'a capable cell receives the exact trusted base recipe',
        async (content, feature) => {
            const t = await acquire(content, [feature]);
            expect(t.result).toMatchObject({ cellId: CELL });
            expect(
                t.sent.find((m) => m.type === 'claim.acquire').body.recipe
                    .content,
            ).toBe(content);
            await t.conn.onClose();
        },
    );
    it('invalid source fails closed before a claim frame or row', async () => {
        const t = await acquire('version: 1\nfakes: {unknown: true}\n', [
            'recipeFakes',
            'seededSQL',
        ]);
        expect(t.result).toMatchObject({
            status: 'blocked',
            blockers: [
                { kind: 'recipe_outdated', signature: 'recipe_invalid' },
            ],
        });
        expect(t.sent.filter((m) => m.type === 'claim.acquire')).toHaveLength(
            0,
        );
        expect(await t.store.claim(claimIdFor('org', 'run:base:1'))).toBeNull();
        await t.conn.onClose();
    });
    it('no recipe content keeps the existing path on an older cell', async () => {
        const t = await acquire(null);
        expect(t.result).toMatchObject({ cellId: CELL });
        await t.conn.onClose();
    });
});
