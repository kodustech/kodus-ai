import { randomUUID } from 'crypto';

import * as amqp from 'amqplib';
import { MongoClient } from 'mongodb';
import WebSocket from 'ws';

import {
    isTerminal,
    sealingKeyFrom,
    RUNTIME_EXCHANGE,
    RUNTIME_PUBLISH_BINDING,
    RUNTIME_RUN_ROUTING_KEY,
    RuntimeEventName,
    runtimeRunOutboxMessage,
    RUNTIME_RUNS_COLLECTION,
} from '@libs/runtime/run';

import { devSealKey } from '../testing/dev-seal-key';
import { shopRunRequest } from './fixtures';
import { recordProductTarget } from './product-target';
import { readRunStreamForE2e } from './run-stream-reader';

// End-to-end Run against docker-compose.runtime.yml: publishes the same
// message the product outbox relay would (OutboxMessage without a job, full
// payload), then follows the Run until it reaches a verdict.

const rabbitUrl = process.env.RUNTIME_RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5673';
const mongoUrl = process.env.RUNTIME_MONGO_URL ?? 'mongodb://localhost:27018';
const metricsUrls = (process.env.RUNTIME_METRICS_URLS ?? 'http://localhost:9464/metrics,http://localhost:9465/metrics').split(',');

/** A second cell sends a step.result for a step the hub never sent it: protocol.violation. */
async function forgedFrame() {
    const url = process.env.RUNTIME_HUB_WS_URL ?? 'ws://localhost:3410/cells';
    const ws = new WebSocket(url, { headers: { authorization: 'Bearer dev-rogue-token', 'x-kodus-cell-id': 'rogue-cell' } });
    await new Promise<void>((resolve) => {
        ws.on('open', () => {
            const env = (type: string, body: unknown, extra = {}) => JSON.stringify({ v: 1, id: randomUUID(), cellId: 'rogue-cell', type, body, ...extra });
            ws.send(env('hello', { versions: [1], driver: 'fake', isolation: 'vm', regions: ['local'], owner: 'kodus' }));
            ws.send(env('step.result', { stepId: randomUUID(), executor: 'observer', imageId: 'img', vmHealth: 'ok' }, { claimId: 'claim-of-someone-else' }));
        });
        ws.on('message', (d) => {
            const m = JSON.parse(d.toString());
            if (m.type === 'nack') {
                console.log(`rogue cell got nack: ${JSON.stringify(m.body)}`);
                ws.close();
                resolve();
            }
        });
        ws.on('error', () => resolve());
        setTimeout(resolve, 5_000);
    });
}

async function main() {
    // The worker opens the tokens with its RUNTIME_SECRET_SEAL_KEY: seal with the same one (the dev key by default).
    const sealKey = process.env.RUNTIME_SECRET_SEAL_KEY ? sealingKeyFrom(process.env.RUNTIME_SECRET_SEAL_KEY) : devSealKey();
    const req = shopRunRequest({ correlationId: randomUUID() }, sealKey);
    // The product records the publish target before the outbox row; so does this stand-in.
    console.log(`runtime_run_targets: ${await recordProductTarget(req)}`);
    const conn = await amqp.connect(rabbitUrl);
    const ch = await conn.createChannel();
    await ch.assertExchange(RUNTIME_EXCHANGE, 'topic', { durable: true });
    // A probe queue standing in for the product worker's consumer of runtime_publish.
    const sink = await ch.assertQueue('', { exclusive: true });
    await ch.bindQueue(sink.queue, RUNTIME_EXCHANGE, RUNTIME_PUBLISH_BINDING);
    const publishes: any[] = [];
    await ch.consume(sink.queue, (m) => m && publishes.push(JSON.parse(m.content.toString())), { noAck: true });

    const row = runtimeRunOutboxMessage(req, RuntimeEventName.RunRequested, randomUUID());
    ch.publish(row.exchange, RUNTIME_RUN_ROUTING_KEY, Buffer.from(JSON.stringify(row.payload)), {
        persistent: true,
        correlationId: req.correlationId,
        headers: { 'x-correlation-id': req.correlationId, 'x-job-id': undefined },
    });
    console.log(`published RuntimeRunRequested runId=${req.runId} correlationId=${req.correlationId} (jobId: none)`);

    const mongo = await MongoClient.connect(mongoUrl);
    const runs = mongo.db(process.env.RUNTIME_MONGO_DB ?? 'kodus').collection(RUNTIME_RUNS_COLLECTION);
    const deadline = Date.now() + 120_000;
    let run: any;
    let lastState = '';
    while (Date.now() < deadline) {
        run = await runs.findOne({ runId: req.runId }, { projection: { _id: 0 } });
        if (run?.state && run.state !== lastState) {
            console.log(`state: ${run.state}${run.phase ? ` (phase ${run.phase})` : ''}`);
            lastState = run.state;
        }
        if (run && isTerminal(run.state) && run.published?.length) break;
        await new Promise((r) => setTimeout(r, 500));
    }
    await new Promise((r) => setTimeout(r, 1_000));

    const stream = await readRunStreamForE2e(req.organizationId, req.runId);
    console.log('\n--- Run stream (Durable Streams offsets, written by runtime-hub) ---');
    for (const e of stream?.events ?? []) console.log(`${e.at}  ${e.type.padEnd(13)} ${JSON.stringify(e.data)}`);
    console.log(`nextOffset=${stream?.nextOffset} upToDate=${stream?.upToDate}`);

    console.log('\n--- Verdict ---');
    console.log(JSON.stringify({ state: run?.state, verdictState: run?.verdictState, check: run?.check, probes: run?.probes?.map((p: any) => `${p.probeId}: ${p.verdict}`) }, null, 2));

    console.log('\n--- RuntimePublishRequested on workflow.jobs.runtime_publish (no target in the message) ---');
    for (const p of publishes) console.log(JSON.stringify({ event: p.event_name, key: p.payload.key, kind: p.payload.kind, conclusion: p.payload.check?.conclusion, title: p.payload.check?.title }));

    await forgedFrame();
    await new Promise((r) => setTimeout(r, 1_500));
    console.log('\n--- §11 metrics ---');
    for (const url of metricsUrls) {
        try {
            const text = await (await fetch(url)).text();
            const lines = text
                .split('\n')
                .filter((l) => /^(protocol_violation|reaper_terminated|egress_blocked|llm_gateway_budget|runtime_queue_wait|runtime_run_state|cell_connected|runtime_verdict)/.test(l))
                .filter((l) => !l.includes('_bucket'));
            console.log(`${url}\n  ${lines.join('\n  ')}`);
        } catch (e) {
            console.log(`${url}: ${(e as Error).message}`);
        }
    }
    await mongo.close();
    await conn.close();
    if (!run || !isTerminal(run.state)) {
        console.error('Run did not reach a verdict in time');
        process.exit(1);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
