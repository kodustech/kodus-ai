import { randomUUID } from 'crypto';

import { RuntimeMetrics } from '@libs/runtime/telemetry';
import { MAX_FRAME_BYTES } from '@libs/runtime/protocol';

import { HubMetrics } from '../hub-types';
import { CellConnectionRegistry } from './cell-connections';

function harness() {
    const socket = { bufferedAmount: 0, send: jest.fn(), close: jest.fn(), terminate: jest.fn() };
    const registry = new CellConnectionRegistry({ disconnect: jest.fn() }, new RuntimeMetrics(), new HubMetrics(), 'replica', jest.fn());
    const conn = registry.add(socket, { cellId: 'cell-a', owner: 'kodus' });
    conn.helloDone = true;
    return { socket, registry, conn };
}

describe('cell connection backpressure', () => {
    afterEach(() => jest.useRealTimers());

    it('drops a non-reading cell before adding another frame to an already full socket', () => {
        // The old send path ignored ws.bufferedAmount and kept accepting frames.
        const { socket, registry, conn } = harness();
        socket.bufferedAmount = 4 * 1024 * 1024;
        expect(registry.send(conn, registry.envelope('cell-a', 'ack', {}, { re: randomUUID() }))).toBe(false);
        expect(socket.send).not.toHaveBeenCalled();
        expect(conn.closed).toBe(true);
        expect(socket.terminate).toHaveBeenCalledTimes(1);
        expect(registry.get('cell-a')).toBeUndefined();
    });

    it('bounds pending acknowledgements and rejects every waiter on overflow', async () => {
        // The old registry admitted arbitrary requests, each with a timer and Promise.
        jest.useFakeTimers();
        const { registry, conn } = harness();
        const waits = Array.from({ length: 300 }, () => {
            try {
                return registry.request('cell-a', 'claim.release', {}, 'claim-a').catch(() => 'unavailable');
            } catch {
                return Promise.resolve('unavailable');
            }
        });
        expect(conn.closed).toBe(true);
        expect(conn.pending.size).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
        expect(await Promise.all(waits)).toEqual(Array(300).fill('unavailable'));
    });

    it('clears step-frame correlation entries when dropping a connection', () => {
        const { registry, conn } = harness();
        conn.stepFrames.set(randomUUID(), randomUUID());
        registry.drop(conn, 'test drop');
        expect(conn.stepFrames.size).toBe(0);
    });

    it('never writes a frame larger than the protocol ceiling', () => {
        const { registry, conn, socket } = harness();
        const frame = registry.envelope('cell-a', 'nack', { code: 'test', message: 'x'.repeat(MAX_FRAME_BYTES) }, { re: randomUUID() });
        expect(registry.send(conn, frame)).toBe(false);
        expect(socket.send).not.toHaveBeenCalled();
        expect(conn.closed).toBe(true);
    });

    it('includes the next frame in the outgoing byte bound and permits the exact boundary', () => {
        const { registry, conn, socket } = harness();
        const frame = registry.envelope('cell-a', 'ack', {}, { re: randomUUID() });
        const bytes = Buffer.byteLength(JSON.stringify(frame));
        socket.bufferedAmount = 4 * 1024 * 1024 - bytes;
        expect(registry.send(conn, frame)).toBe(true);
        socket.bufferedAmount++;
        expect(registry.send(conn, frame)).toBe(false);
        expect(socket.send).toHaveBeenCalledTimes(1);
    });

    it('settles bounded in-flight steps and readies without affecting a healthy cell', async () => {
        jest.useFakeTimers();
        const { registry, conn } = harness();
        const steps: Array<Promise<unknown>> = [];
        for (let i = 0; i < 257; i++) {
            const stepId = randomUUID();
            steps.push(new Promise((resolve) => conn.steps.set(stepId, { claimId: 'claim-a', resolve, timer: setTimeout(() => undefined, 100_000) })));
            conn.stepFrames.set(randomUUID(), stepId);
        }
        const ready = new Promise((resolve) => conn.readies.set('claim-a', { resolve, timer: setTimeout(() => undefined, 100_000) }));
        const healthySocket = { bufferedAmount: 0, send: jest.fn(), close: jest.fn() };
        const healthy = registry.add(healthySocket, { cellId: 'cell-b', owner: 'kodus' });
        healthy.helloDone = true;
        expect(registry.send(conn, registry.envelope('cell-a', 'ack', {}, { re: randomUUID() }))).toBe(false);
        expect(await Promise.all(steps)).toEqual(Array(257).fill({ type: 'lost' }));
        expect(await ready).toEqual({ type: 'lost', why: 'disconnected' });
        expect(conn.steps.size + conn.readies.size + conn.stepFrames.size).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
        expect(registry.send(healthy, registry.envelope('cell-b', 'ack', {}, { re: randomUUID() }))).toBe(true);
        expect(healthySocket.close).not.toHaveBeenCalled();
    });

    it('releases acknowledged request capacity for healthy control traffic', async () => {
        jest.useFakeTimers();
        const { registry, conn, socket } = harness();
        const pending = registry.request('cell-a', 'claim.release', {}, 'claim-a');
        const request = JSON.parse(socket.send.mock.calls[0][0]);
        const reply = registry.envelope('cell-a', 'ack', {}, { re: request.id });
        expect(registry.answer(conn, request.id, reply)).toBe(true);
        expect(await pending).toEqual(reply);
        expect(conn.pending.size).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
        expect(conn.closed).toBe(false);
    });
});
