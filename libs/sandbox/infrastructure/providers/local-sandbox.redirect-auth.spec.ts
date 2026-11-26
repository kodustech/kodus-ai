/**
 * Review on #2709 (Kody): when a git server redirects, the fetch runs again
 * where it led. The org's token goes only to the origin it was given for
 * (scheme, host and port), as curl does on a redirect it follows itself: a
 * server that redirects elsewhere does not get to hand the token to that host.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { PlatformType } from '@libs/core/domain/enums';
import { LocalSandboxService } from './local-sandbox.service';

jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: false },
}));

type Seen = { url: string; ua: string; auth?: string };

function recorder(handle: (path: string) => string | undefined) {
    const seen: Seen[] = [];
    const server = createServer((req, res) => {
        seen.push({
            url: req.url ?? '',
            ua: String(req.headers['user-agent']),
            auth: req.headers.authorization,
        });
        const location = handle(req.url ?? '');
        if (location) {
            res.statusCode = 301;
            res.setHeader('location', location);
        } else {
            res.statusCode = 404;
        }
        res.end();
    });
    return { server, seen };
}

const listen = (s: Server) =>
    new Promise<number>((r) =>
        s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)),
    );
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

describe('a redirected sandbox clone keeps the token on its own origin', () => {
    const target = recorder(() => undefined);
    let targetPort: number;
    let redirectTo: (path: string) => string;
    const origin = recorder((path) => redirectTo(path));
    let originPort: number;

    beforeAll(async () => {
        targetPort = await listen(target.server);
        originPort = await listen(origin.server);
    });
    afterAll(async () => {
        await close(target.server);
        await close(origin.server);
    });
    beforeEach(() => {
        target.seen.length = 0;
        origin.seen.length = 0;
    });

    const clone = () =>
        new LocalSandboxService({} as any)
            .createSandboxWithRepo({
                cloneUrl: `http://127.0.0.1:${originPort}/g/r.git`,
                authToken: 'ghtok-canary',
                branch: 'main',
                platform: PlatformType.GITHUB,
            })
            .catch(() => undefined);
    const byGit = (seen: Seen[]) => seen.filter((r) => r.ua.startsWith('git/'));

    it('a redirect to another host gets no token from the fetch that follows', async () => {
        redirectTo = (path) =>
            `http://localhost:${targetPort}${path.replace('/g/r.git', '/moved/r.git')}`;
        await clone();
        // The origin got the token, from git and from the probe.
        expect(byGit(origin.seen).map((r) => r.auth)).toContain(
            `Basic ${Buffer.from('x-access-token:ghtok-canary').toString('base64')}`,
        );
        // The host it redirected to was fetched from, without it.
        const atTarget = byGit(target.seen);
        expect(atTarget.length).toBeGreaterThan(0);
        expect(atTarget.map((r) => r.auth)).toEqual(
            atTarget.map(() => undefined),
        );
    }, 60_000);

    it('a redirect within the same origin keeps the token', async () => {
        redirectTo = (path) =>
            path.startsWith('/g/r.git')
                ? `http://127.0.0.1:${originPort}${path.replace('/g/r.git', '/moved/r.git')}`
                : '';
        await clone();
        const moved = byGit(origin.seen).filter((r) =>
            r.url.startsWith('/moved/'),
        );
        expect(moved.length).toBeGreaterThan(0);
        expect(new Set(moved.map((r) => r.auth))).toEqual(
            new Set([
                `Basic ${Buffer.from('x-access-token:ghtok-canary').toString('base64')}`,
            ]),
        );
    }, 60_000);
});
