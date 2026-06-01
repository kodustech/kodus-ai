import http from 'node:http';
import { AddressInfo } from 'node:net';
import open from 'open';

import { cliAuthApi, type CliLoginPollResponse } from './api/cli-auth.api.js';

const POLL_INTERVAL_MS = 1_000;
const POLL_MAX_DELAY_MS = 5_000;
const TOTAL_TIMEOUT_MS = 10 * 60 * 1000;
const CALLBACK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Kodus CLI authorized</title>
<style>
  body { font: 14px system-ui, sans-serif; padding: 4rem; text-align: center; color: #1f2937; }
  h1 { font-size: 1.25rem; }
  p { color: #6b7280; }
</style>
</head>
<body>
  <h1>You're all set</h1>
  <p>The Kodus CLI received your authorization. You can close this tab.</p>
</body>
</html>`;

export interface BrowserLoginResult {
    accessToken: string;
    refreshToken: string;
    userEmail?: string;
}

interface CallbackResult {
    state: string;
}

/**
 * Loopback OAuth-style login (RFC 8252).
 *
 * Flow:
 *   1. Spin up an HTTP server on a random localhost port.
 *   2. POST /cli/auth/login-init with that port — backend returns the
 *      verification URI (already composed from API_FRONTEND_URL on the
 *      server side, so self-hosted just works).
 *   3. Open the verification URI in the user's browser.
 *   4. After the user clicks "Authorize" on the web, the backend redirects
 *      the browser to http://127.0.0.1:<port>/callback?state=<state>.
 *   5. Server resolves the callback, then we GET /cli/auth/login-poll?state=
 *      over HTTPS to fetch the JWT. The token never traverses the browser.
 */
export async function loginViaBrowser({
    onOpenUrl,
}: {
    onOpenUrl?: (url: string) => void;
} = {}): Promise<BrowserLoginResult> {
    const { server, port, callbackPromise } = await startCallbackServer();

    try {
        const init = await cliAuthApi.initLoopback(port);

        if (onOpenUrl) {
            onOpenUrl(init.verificationUri);
        }

        try {
            await open(init.verificationUri);
        } catch {
            // Browser may not be available; user can still copy the URL
            // manually. The callback server keeps waiting either way.
        }

        // Race the callback against an expiry timeout. We MUST cancel the
        // timer once the callback wins — without `cancel()` the underlying
        // `setTimeout` keeps the Node event loop alive for the full
        // `expiresIn` window (10 min by default), so the CLI hangs after a
        // successful login until the timer naturally fires.
        const expiry = timeout<CallbackResult>(
            init.expiresIn * 1000,
            'Authorization timed out. Run `kodus auth login` again.',
        );
        let callback: CallbackResult;
        try {
            callback = await Promise.race([callbackPromise, expiry.promise]);
        } finally {
            expiry.cancel();
        }

        if (callback.state !== init.state) {
            throw new Error(
                'Authorization state mismatch. The callback did not match the initial request — refusing to use the response for security reasons.',
            );
        }

        const tokens = await pollUntilTerminal(init.state);
        return tokens;
    } finally {
        await closeServer(server);
    }
}

async function startCallbackServer(): Promise<{
    server: http.Server;
    port: number;
    callbackPromise: Promise<CallbackResult>;
}> {
    let resolveCallback: (result: CallbackResult) => void;
    let rejectCallback: (err: Error) => void;
    const callbackPromise = new Promise<CallbackResult>((resolve, reject) => {
        resolveCallback = resolve;
        rejectCallback = reject;
    });

    const server = http.createServer((req, res) => {
        if (!req.url) {
            res.writeHead(400).end();
            return;
        }
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname !== '/callback') {
            res.writeHead(404, { Connection: 'close' }).end();
            return;
        }
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        // Connection: close — keep-alive sockets would block the Node event
        // loop after server.close(), leaving the CLI hanging when the user
        // tries to run another command in the same shell.
        res.writeHead(error ? 400 : 200, {
            'Content-Type': 'text/html; charset=utf-8',
            Connection: 'close',
        });
        res.end(CALLBACK_HTML);

        if (error) {
            rejectCallback(new Error(`Authorization denied: ${error}`));
            return;
        }
        if (!state) {
            rejectCallback(new Error('Callback missing state parameter'));
            return;
        }
        resolveCallback({ state });
    });

    // Don't keep keep-alive sockets idle — the browser will sometimes hold
    // the connection open after the response, which would prevent the
    // process from exiting after the login finishes.
    server.keepAliveTimeout = 0;

    // Bind only to loopback — never expose this server to other hosts.
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address() as AddressInfo;
    return { server, port: address.port, callbackPromise };
}

function closeServer(server: http.Server): Promise<void> {
    return new Promise((resolve) => {
        // closeAllConnections is available on Node 18.2+. Force any
        // lingering keep-alive sockets to drop so the process can exit.
        const anyServer = server as http.Server & {
            closeAllConnections?: () => void;
            closeIdleConnections?: () => void;
        };
        try {
            anyServer.closeIdleConnections?.();
            anyServer.closeAllConnections?.();
        } catch {
            // ignore — best effort
        }
        server.close(() => resolve());
    });
}

async function pollUntilTerminal(state: string): Promise<BrowserLoginResult> {
    const startedAt = Date.now();
    let delay = POLL_INTERVAL_MS;

    while (Date.now() - startedAt < TOTAL_TIMEOUT_MS) {
        const response: CliLoginPollResponse = await cliAuthApi.poll({ state });

        if (response.status === 'completed') {
            if (!response.accessToken || !response.refreshToken) {
                throw new Error(
                    'Authorization completed but the server returned no tokens',
                );
            }
            return {
                accessToken: response.accessToken,
                refreshToken: response.refreshToken,
                userEmail: response.userEmail,
            };
        }

        if (
            response.status === 'expired' ||
            response.status === 'denied' ||
            response.status === 'consumed' ||
            response.status === 'not_found'
        ) {
            throw new Error(
                `Authorization ${response.status}. Run \`kodus auth login\` again.`,
            );
        }

        await sleep(delay);
        delay = Math.min(delay * 2, POLL_MAX_DELAY_MS);
    }

    throw new Error('Authorization timed out while polling for tokens');
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cancellable timeout: returns a promise that rejects after `ms`, plus a
 * `cancel()` to clear the underlying timer when the caller no longer
 * needs it (e.g. when racing against another promise that won). Without
 * `cancel()`, the unref'd timer would keep the event loop alive for the
 * full duration even after the race resolved.
 */
function timeout<T>(
    ms: number,
    message: string,
): { promise: Promise<T>; cancel: () => void } {
    let timer: NodeJS.Timeout | undefined;
    const promise = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return {
        promise,
        cancel: () => {
            if (timer) {clearTimeout(timer);}
        },
    };
}
