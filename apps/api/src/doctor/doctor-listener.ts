import { createHmac, timingSafeEqual } from 'crypto';
import * as http from 'http';

import type { DoctorReport } from './doctor.types';

/**
 * Loopback-only listener for the self-hosted doctor (#1987).
 *
 * Not a route on the public Nest app: that one sits behind ingress, CORS,
 * `trust proxy` and every global middleware. This server binds 127.0.0.1 on
 * its own port, so it is reachable only from inside the API container
 * (`docker compose exec api` / `kubectl exec`). The HMAC token still gates
 * it, because a sidecar proxy or `network_mode: host` also connects from
 * loopback. Whoever holds the token already holds API_CRYPTO_KEY, i.e. every
 * secret of the install, so the doctor grants nothing new.
 */
export const DOCTOR_DEFAULT_PORT = 3335;
export const DOCTOR_PATH = '/doctor';
export const DOCTOR_TOKEN_HEADER = 'x-kodus-doctor-token';
const TOKEN_CONTEXT = 'kodus-selfhosted-doctor-v1';
/** A finished report is reused for this long: one run costs LLM + Git calls. */
export const DOCTOR_REUSE_MS = 30_000;

export function doctorToken(cryptoKey: string): string {
    return createHmac('sha256', cryptoKey).update(TOKEN_CONTEXT).digest('hex');
}

export function isLoopback(address?: string): boolean {
    return (
        address === '127.0.0.1' ||
        address === '::1' ||
        address === '::ffff:127.0.0.1'
    );
}

function tokenMatches(given: string | undefined, expected: string): boolean {
    if (!given) {
        return false;
    }
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

export function createDoctorHandler(opts: {
    cryptoKey: string;
    run: () => Promise<DoctorReport>;
    now?: () => number;
}): http.RequestListener {
    const expected = doctorToken(opts.cryptoKey);
    const now = opts.now ?? Date.now;
    let inFlight: Promise<DoctorReport> | null = null;
    let last: { at: number; report: DoctorReport } | null = null;

    // Single flight: concurrent callers share one run; a recent report is
    // reused, so the endpoint cannot be used to multiply LLM/Git calls.
    const report = (): Promise<DoctorReport> => {
        if (last && now() - last.at < DOCTOR_REUSE_MS) {
            return Promise.resolve(last.report);
        }
        if (!inFlight) {
            inFlight = opts
                .run()
                .then((r) => {
                    last = { at: now(), report: r };
                    return r;
                })
                .finally(() => {
                    inFlight = null;
                });
        }
        return inFlight;
    };

    const send = (res: http.ServerResponse, status: number, body: unknown) => {
        res.writeHead(status, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
        });
        res.end(JSON.stringify(body));
    };

    return (req, res) => {
        if (!isLoopback(req.socket.remoteAddress)) {
            return send(res, 403, { error: 'loopback only' });
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method !== 'GET' || url.pathname !== DOCTOR_PATH) {
            return send(res, 404, { error: 'not found' });
        }
        const given = req.headers[DOCTOR_TOKEN_HEADER];
        if (!tokenMatches(Array.isArray(given) ? given[0] : given, expected)) {
            return send(res, 401, { error: 'invalid token' });
        }
        report().then(
            (r) => send(res, 200, r),
            (error) =>
                send(res, 500, {
                    error: String(error?.message ?? error).slice(0, 200),
                }),
        );
    };
}

/**
 * Starts the listener unless this is Kodus Cloud or the key is unusable.
 * Returns null when not started; never throws, so it cannot break API boot.
 */
export function startDoctorListener(opts: {
    cloudMode: boolean;
    env: NodeJS.ProcessEnv;
    run: () => Promise<DoctorReport>;
    log: (message: string) => void;
}): http.Server | null {
    const { env } = opts;
    if (opts.cloudMode || (env.API_DOCTOR_ENABLED ?? 'true') === 'false') {
        return null;
    }
    if (!env.API_CRYPTO_KEY) {
        opts.log('[doctor] API_CRYPTO_KEY unset; doctor listener not started');
        return null;
    }
    const port = Number(env.API_DOCTOR_PORT) || DOCTOR_DEFAULT_PORT;
    const server = http.createServer(
        createDoctorHandler({ cryptoKey: env.API_CRYPTO_KEY, run: opts.run }),
    );
    // A report on a large install (many repos, a slow model) takes minutes.
    server.requestTimeout = 10 * 60_000;
    server.on('error', (error) =>
        opts.log(`[doctor] listener error: ${error.message}`),
    );
    server.listen(port, '127.0.0.1', () =>
        opts.log(`[doctor] listening on 127.0.0.1:${port}`),
    );
    return server;
}
