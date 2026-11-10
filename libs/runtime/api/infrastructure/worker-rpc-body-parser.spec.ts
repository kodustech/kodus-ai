import { existsSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';

function app() {
    const path = join(__dirname, 'worker-rpc-body-parser.ts');
    expect(existsSync(path)).toBe(true);
    const {
        runtimeModelTurnJsonParser,
        runtimePlannerSourceJsonParser,
    } = require(path);
    const server = express();
    server.use('/internal/runtime/model-turn', ...runtimeModelTurnJsonParser());
    server.use(
        '/internal/runtime/planner-source',
        ...runtimePlannerSourceJsonParser(),
    );
    server.use(express.json({ limit: '25mb' }));
    server.post(
        [
            '/internal/runtime/model-turn',
            '/internal/runtime/planner-source',
            '/ordinary',
        ],
        (req, res) => res.json({ parsed: req.body }),
    );
    return server;
}

describe('Runtime worker RPC HTTP parser', () => {
    it('parses ordinary UTF-8 JSON before the product parser', async () => {
        await request(app())
            .post('/internal/runtime/model-turn')
            .send({ v: 1, text: 'ação' })
            .expect(200, { parsed: { v: 1, text: 'ação' } });
    });

    it('refuses ambiguous keys before JSON parsing can discard the first value', async () => {
        await request(app())
            .post('/internal/runtime/model-turn')
            .type('json')
            .send('{"scope":{"runId":"first","runId":"second"}}')
            .expect(400, { error: 'invalid_request' });
    });

    it('bounds decoded body bytes separately for model turns and source reads', async () => {
        await request(app())
            .post('/internal/runtime/model-turn')
            .send({ text: 'x'.repeat(2_000_000) })
            .expect(413, { error: 'request_too_large' });
        await request(app())
            .post('/internal/runtime/planner-source')
            .send({ text: 'x'.repeat(300_000) })
            .expect(413, { error: 'request_too_large' });
    });

    it('refuses excessive nesting and malformed UTF-8', async () => {
        const deep = '{"x":'.repeat(34) + '0' + '}'.repeat(34);
        await request(app())
            .post('/internal/runtime/model-turn')
            .type('json')
            .send(deep)
            .expect(400, { error: 'invalid_request' });
        const invalid = Buffer.from([
            0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
        ]);
        // Superagent otherwise JSON-serializes Buffer as {type,data}.
        await request(app())
            .post('/internal/runtime/planner-source')
            .type('json')
            .serialize(() => invalid as any)
            .send(invalid)
            .expect(400, { error: 'invalid_request' });
    });

    it('returns fixed parser errors without reflecting payloads or internal diagnostics', async () => {
        const response = await request(app())
            .post('/internal/runtime/model-turn')
            .type('json')
            .send('{"token":"parser-secret-sentinel",')
            .expect(400);
        expect(response.body).toEqual({ error: 'invalid_request' });
        expect(response.text).not.toContain('parser-secret-sentinel');
    });

    it('requires JSON only on the new RPCs and preserves ordinary product parsing', async () => {
        await request(app())
            .post('/internal/runtime/model-turn')
            .type('text')
            .send('{}')
            .expect(415, { error: 'unsupported_media_type' });
        await request(app())
            .post('/ordinary')
            .type('json')
            .send('{"x":1,"x":2}')
            .expect(200, { parsed: { x: 2 } });
    });
});
