import fs from 'node:fs/promises';
import path from 'node:path';
import { incidentsPath } from './store-paths.js';
import type { TraceIncident } from '../../types/trace.js';

/**
 * Everything on the capture path fails open, which means a silent failure is
 * indistinguishable from "nothing happened". Anything that goes wrong and
 * matters is written here so `trace status` can surface it.
 */
export async function recordIncident(
    gitRoot: string,
    incident: TraceIncident,
): Promise<void> {
    try {
        const filePath = incidentsPath(gitRoot);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.appendFile(filePath, `${JSON.stringify(incident)}\n`, 'utf-8');
    } catch {
        // Reporting a failure must not itself fail the push.
    }
}

export async function readIncidents(
    gitRoot: string,
    limit = 10,
): Promise<TraceIncident[]> {
    try {
        const raw = await fs.readFile(incidentsPath(gitRoot), 'utf-8');
        const incidents = raw
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                try {
                    return JSON.parse(line) as TraceIncident;
                } catch {
                    return null;
                }
            })
            .filter((entry): entry is TraceIncident => entry !== null);

        return incidents.slice(-limit).reverse();
    } catch {
        return [];
    }
}

export async function clearIncidents(gitRoot: string): Promise<void> {
    await fs.rm(incidentsPath(gitRoot), { force: true }).catch(() => {});
}
