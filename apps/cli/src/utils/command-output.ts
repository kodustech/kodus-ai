import fs from 'fs/promises';
import { CLI_VERSION } from '../constants.js';
import type {
    AgentEnvelope,
    AgentErrorPayload,
    AgentErrorEnvelope,
    AgentSuccessEnvelope,
} from '../types/command-output.js';

function normalizeDuration(startedAt: number): number {
    const value = Date.now() - startedAt;
    if (Number.isFinite(value) && value >= 0) {
        return value;
    }
    return 0;
}

export function buildAgentSuccessEnvelope<T>(
    command: string,
    data: T,
    startedAt: number,
): AgentSuccessEnvelope<T> {
    return {
        ok: true,
        command,
        data,
        error: null,
        meta: {
            schemaVersion: '1.0',
            cliVersion: CLI_VERSION,
            mode: 'agent',
            durationMs: normalizeDuration(startedAt),
        },
    };
}

export function buildAgentErrorEnvelope(
    command: string,
    error: AgentErrorPayload,
    startedAt: number,
): AgentErrorEnvelope {
    return {
        ok: false,
        command,
        data: null,
        error,
        meta: {
            schemaVersion: '1.0',
            cliVersion: CLI_VERSION,
            mode: 'agent',
            durationMs: normalizeDuration(startedAt),
        },
    };
}

export async function emitAgentEnvelope(
    envelope: AgentEnvelope<unknown>,
    outputFile?: string,
): Promise<void> {
    const payload = JSON.stringify(envelope, null, 2);

    if (outputFile) {
        await fs.writeFile(outputFile, payload, 'utf-8');
        return;
    }

    process.stdout.write(`${payload}\n`);
}
