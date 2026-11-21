import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { createServer as createHttpsServer } from 'https';

import type { INestApplication, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';

import type { RuntimeConfig } from '../shared/config';
import { RuntimeLogger } from '../shared/observability/logger';
import { RuntimeHubModule } from './runtime-hub.module';

/**
 * The hub's Nest app on two listeners (ADR-054):
 *  - public (RUNTIME_HUB_PORT): the cells. It asks for a client certificate without
 *    requiring one at the handshake (/cells/register has none yet); CellGatewayService
 *    and the routes enforce it per connection.
 *  - internal (RUNTIME_HUB_INTERNAL_PORT): the worker, private network only. It
 *    requires a client certificate from the worker CA at the handshake.
 * Each listener serves only its own routes: /internal/* is 404 on the public port and
 * everything else is 404 on the internal one.
 */
export async function createRuntimeHubApp(config: RuntimeConfig, logger: LoggerService | Array<'log' | 'warn' | 'error'> = new RuntimeLogger('runtime-hub')) {
    const tls = config.tls;
    if (!config.testOnlyPlaintext && !(tls?.cert && tls.key)) throw new Error('runtime-hub: RUNTIME_TLS_CERT/KEY/CA are required (mTLS, ADR-054)');
    const httpsOptions = tls?.cert && tls.key ? { cert: tls.cert, key: tls.key, ca: tls.ca, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3' as const } : undefined;
    // Bodies are parsed here, not by Nest's defaults: a sandbox write (half a MiB of
    // base64, docs/runtime/sandbox.md) is the one route that takes more than 100 kB.
    const app = await NestFactory.create(RuntimeHubModule, { logger, httpsOptions, bodyParser: false });
    const small = [json({ limit: '100kb' }), urlencoded({ extended: true, limit: '100kb' })];
    const sandboxOp = json({ limit: '1mb' });
    app.use((req: IncomingMessage, res: ServerResponse, next: (e?: unknown) => void) => {
        if (/^\/internal\/claims\/[^/?]+\/sandbox-op(\?|$)/.test(req.url ?? '')) return sandboxOp(req as never, res as never, next);
        small[0](req as never, res as never, (e?: unknown) => (e ? next(e) : small[1](req as never, res as never, next)));
    });
    app.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const internalRoute = (req.url ?? '/').startsWith('/internal');
        const onInternal = req.socket.localPort === config.internalPort;
        if (internalRoute !== onInternal) {
            res.statusCode = 404;
            res.setHeader('content-type', 'application/json');
            return res.end(JSON.stringify({ statusCode: 404, message: 'Not Found' }));
        }
        next();
    });
    if (!httpsOptions) new RuntimeLogger('runtime-hub').write('warn', 'RUNTIME_TEST_ONLY_PLAINTEXT=1: plain HTTP and shared tokens. Test only.');
    return { app, mtls: !!httpsOptions };
}

/** Opens both listeners; close() closes the internal one (app.close() closes the public one). */
export async function listenRuntimeHub(app: INestApplication, config: RuntimeConfig, host = '0.0.0.0'): Promise<{ internal: Server; close: () => Promise<void> }> {
    await app.listen(config.hubPort, host);
    const handler = app.getHttpAdapter().getInstance();
    const tls = config.tls;
    const internal: Server =
        tls?.cert && tls.key
            ? createHttpsServer({ cert: tls.cert, key: tls.key, ca: tls.workerCa ?? tls.ca, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, handler)
            : createHttpServer(handler);
    await new Promise<void>((resolve, reject) => {
        internal.once('error', reject);
        internal.listen(config.internalPort, host, () => resolve());
    });
    return { internal, close: () => new Promise<void>((resolve) => internal.close(() => resolve())) };
}
