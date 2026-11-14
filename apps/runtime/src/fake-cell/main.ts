import { readFileSync } from 'fs';

import WebSocket from 'ws';

import { FakeCell } from './fake-cell';
import { SCENARIOS } from './scenarios';

// The fake cell process: connects out to the hub (the cell never accepts
// inbound connections), reconnects with backoff and jitter.

const url = process.env.RUNTIME_HUB_WS_URL ?? 'ws://localhost:3410/cells';
const cellId = process.env.RUNTIME_CELL_ID ?? 'fake-cell';
const token = process.env.RUNTIME_CELL_TOKEN ?? 'dev-cell-token';
const owner = (process.env.RUNTIME_CELL_OWNER ?? 'kodus') as 'kodus' | 'customer';
const blockedHosts = (process.env.RUNTIME_FAKE_BLOCKED_HOSTS ?? '').split(',').filter(Boolean);

let attempt = 0;
function connect() {
    // mTLS with a cell certificate (CN = cellId) when RUNTIME_CELL_CERT is set; the shared token only reaches a hub in test-only plaintext mode.
    const tls = process.env.RUNTIME_CELL_CERT
        ? { cert: readFileSync(process.env.RUNTIME_CELL_CERT), key: readFileSync(process.env.RUNTIME_CELL_KEY!), ca: readFileSync(process.env.RUNTIME_CELL_CA!) }
        : {};
    const headers = process.env.RUNTIME_CELL_CERT ? {} : { authorization: `Bearer ${token}`, 'x-kodus-cell-id': cellId };
    const ws = new WebSocket(url, { headers, perMessageDeflate: false, ...tls });
    const cell = new FakeCell({ cellId, owner, scenarios: SCENARIOS, send: (f) => ws.send(f), blockedHosts, log: (m) => console.log(`[fake-cell] ${m}`) });
    let beat: NodeJS.Timeout | undefined;
    ws.on('open', () => {
        attempt = 0;
        console.log(`[fake-cell] ${cellId} connected to ${url}`);
        cell.hello();
        beat = setInterval(() => cell.heartbeat(), 10_000);
        setTimeout(() => cell.heartbeat(), 500);
    });
    ws.on('message', (data) => void cell.onFrame(data.toString()).catch((e) => console.error('[fake-cell] frame failed', e)));
    ws.on('close', () => {
        if (beat) clearInterval(beat);
        const delay = Math.min(30_000, 500 * 2 ** attempt++) * (0.5 + Math.random());
        console.log(`[fake-cell] disconnected; reconnecting in ${Math.round(delay)} ms`);
        setTimeout(connect, delay);
    });
    ws.on('error', (e) => console.error(`[fake-cell] ${e.message}`));
}

connect();
