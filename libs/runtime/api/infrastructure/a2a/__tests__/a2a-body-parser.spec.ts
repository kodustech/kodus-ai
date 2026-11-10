import express from 'express';
import request from 'supertest';
import { runtimeA2AJsonParser } from '../a2a-body-parser';

function app() {
    const server = express();
    server.use('/runtime/a2a', ...runtimeA2AJsonParser());
    server.use(express.json({ limit: '25mb' }));
    server.post('/runtime/a2a', (_req, res) => res.json({ admitted: true }));
    server.post('/neighbor', (_req, res) => res.json({ admitted: true }));
    return server;
}

describe('A2A bounded strict parser before the generic product parser', () => {
    it('refuses oversized bodies before dispatch without changing neighboring routes', async () => {
        const payload = JSON.stringify({ value: 'a'.repeat(256 * 1024) });
        const blocked = await request(app())
            .post('/runtime/a2a')
            .set('Content-Type', 'application/json')
            .send(payload);
        expect(blocked.status).toBe(413);
        expect(blocked.body).toEqual({ error: 'request_too_large' });
        expect(
            (
                await request(app())
                    .post('/neighbor')
                    .set('Content-Type', 'application/json')
                    .send(payload)
            ).status,
        ).toBe(200);
    });
    it.each([
        '{"method":"SendMessage","method":"GetTask"}',
        '{"__proto__":{"admitted":true}}',
        '{"value":',
    ])(
        'refuses ambiguous or invalid JSON without reflecting content',
        async (payload) => {
            const out = await request(app())
                .post('/runtime/a2a')
                .set('Content-Type', 'application/json')
                .send(payload);
            expect(out.status).toBe(400);
            expect(out.body).toEqual({ error: 'invalid_request' });
        },
    );
    it('refuses other media types before any generic parser can allocate them', async () => {
        const out = await request(app())
            .post('/runtime/a2a')
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .send('value=' + 'a'.repeat(260 * 1024));
        expect(out.status).toBe(415);
        expect(out.body).toEqual({ error: 'unsupported_media_type' });
    });
    it('supports the A2A JSON media type with strict duplicate checks', async () => {
        const out = await request(app())
            .post('/runtime/a2a')
            .set('Content-Type', 'application/a2a+json')
            .send('{"id":"one","id":"two"}');
        expect(out.status).toBe(400);
        expect(
            (
                await request(app())
                    .post('/runtime/a2a')
                    .set('Content-Type', 'application/a2a+json')
                    .send('{"id":"one"}')
            ).status,
        ).toBe(200);
    });
});
