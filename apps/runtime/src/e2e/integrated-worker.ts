// Test-only process: real production worker, public DBOS inspection, loopback only.
import 'reflect-metadata';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { NestFactory } from '@nestjs/core';
import { createServer, request as proxyRequest } from 'http';
import { createServer as createTlsServer } from 'https';
import { readFileSync } from 'fs';
import { loadWorkerConfig } from '../shared/config';
import { RuntimeWorkerModule } from '../worker/runtime-worker.module';

async function main() {
    const m = JSON.parse(
        readFileSync(process.env.INTEGRATED_MANIFEST!, 'utf8'),
    );
    if (
        !/^kr-int-[a-f0-9-]+$/.test(m.prefix) ||
        process.env.DBOS__VMID !== m.executorId
    )
        throw new Error('owned manifest/executor required');
    const app = await NestFactory.createApplicationContext(
        RuntimeWorkerModule.forConfig(loadWorkerConfig()),
        { logger: ['error', 'warn', 'log'] },
    );
    app.enableShutdownHooks();
    await app.init();
    const listener = createServer(async (req, res) => {
        if (req.headers.authorization !== `Bearer ${m.gatewayToken}`) {
            res.writeHead(403).end();
            return;
        }
        try {
            const url = new URL(req.url!, 'http://localhost');
            if (url.pathname === '/health') {
                res.end(
                    JSON.stringify({
                        ready: true,
                        releaseVersion: DBOS.applicationVersion,
                        executorId: DBOS.executorID,
                    }),
                );
                return;
            }
            const runId = url.searchParams.get('runId');
            if (
                url.pathname !== '/workflow' ||
                !runId ||
                !/^[a-f0-9-]{36}$/.test(runId)
            ) {
                res.writeHead(404).end();
                return;
            }
            res.setHeader('content-type', 'application/json');
            res.end(
                JSON.stringify({
                    releaseVersion: DBOS.applicationVersion,
                    executorId: DBOS.executorID,
                    status: await DBOS.getWorkflowStatus(runId),
                    steps: await DBOS.listWorkflowSteps(runId),
                }),
            );
        } catch {
            res.writeHead(500).end();
        }
    });
    await new Promise<void>((r, j) => {
        listener.once('error', j);
        listener.listen(m.ports.workerControl, '127.0.0.1', r);
    });
    // Test-only HTTPS origin: the real evidence server still authenticates every
    // signed object upload/read. The cell trusts only this invocation's CA.
    const evidenceTls = createTlsServer(
        {
            cert: readFileSync(`${m.root}/tls/hub.pem`),
            key: readFileSync(`${m.root}/tls/hub.key`),
            minVersion: 'TLSv1.3',
        },
        (req, res) => {
            const upstream = proxyRequest(
                {
                    hostname: '127.0.0.1',
                    port: m.ports.evidence,
                    path: req.url,
                    method: req.method,
                    headers: req.headers,
                },
                (back) => {
                    res.writeHead(back.statusCode ?? 502, back.headers);
                    back.pipe(res);
                },
            );
            upstream.on('error', () => res.writeHead(502).end());
            req.pipe(upstream);
        },
    );
    await new Promise<void>((r, j) => {
        evidenceTls.once('error', j);
        evidenceTls.listen(m.ports.evidenceTls, '0.0.0.0', r);
    });
    process.once('SIGTERM', () => {
        listener.close();
        evidenceTls.closeAllConnections();
        evidenceTls.close();
    });
}
void main().catch((e) => {
    console.error(e);
    process.exit(1);
});
