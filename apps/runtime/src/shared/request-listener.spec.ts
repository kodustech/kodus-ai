import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { requestListener } from './request-listener';

function listen(server: Server): Promise<number> {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

function get(port: number): Promise<{ status?: number; error?: string }> {
    return new Promise((resolve) => {
        const req = request({ host: '127.0.0.1', port, path: '/' }, (res) => {
            res.on('data', () => undefined);
            res.on('end', () => resolve({ status: res.statusCode }));
            res.on('error', (e) => resolve({ error: e.message }));
        });
        req.on('error', (e) => resolve({ error: e.message }));
        req.end();
    });
}

describe('requestListener', () => {
    let server: Server;
    afterEach(() => new Promise((r) => server.close(r)));

    it('answers 500 when the handler rejects before writing anything', async () => {
        const unhandled = jest.fn();
        process.on('unhandledRejection', unhandled);
        server = createServer(requestListener(async () => {
            throw new Error('boom');
        }));
        const answer = await get(await listen(server));
        process.off('unhandledRejection', unhandled);
        expect(answer.status).toBe(500);
        expect(unhandled).not.toHaveBeenCalled();
    });

    it('cuts the connection when the handler rejects after the headers went out', async () => {
        server = createServer(requestListener(async (_req, res) => {
            res.writeHead(200, { 'content-length': '10' });
            res.write('half');
            throw new Error('boom');
        }));
        const answer = await get(await listen(server));
        expect(answer.error).toBeDefined();
    });
});
