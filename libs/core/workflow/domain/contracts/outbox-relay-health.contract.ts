/**
 * What the outbox relay loop reports about itself, for the worker's health
 * probe. A relay is down when its loop never started, was stopped, or has
 * not finished a cycle for longer than the probe tolerates (a stalled
 * cycle). A cycle skipped because the broker is disconnected still counts
 * as finished: the probe reports the broker on its own.
 */
export interface OutboxRelayLiveness {
    state: 'not_started' | 'running' | 'stopped';
    /** Epoch ms of the last finished cycle (or of the start, before one). */
    lastCycleAt?: number;
}

export interface IOutboxRelayHealth {
    getLiveness(): OutboxRelayLiveness;
}

export const OUTBOX_RELAY_HEALTH_TOKEN = Symbol.for('OutboxRelayHealth');
