import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { traceConfigPath } from './store-paths.js';

export interface AgentCliSpec {
    name: string;
    bin: string;
    args: string[];
}

/**
 * Fixed preference order. Distillation runs unattended from a pre-push hook, so
 * this never prompts — it picks the first CLI on PATH, remembers the choice,
 * and lets a flag or env var override it.
 */
export const AGENT_CLI_PREFERENCE: AgentCliSpec[] = [
    { name: 'claude', bin: 'claude', args: ['-p'] },
    { name: 'codex', bin: 'codex', args: ['exec', '-'] },
    { name: 'gemini', bin: 'gemini', args: ['-p'] },
    { name: 'cursor', bin: 'cursor-agent', args: ['-p'] },
];

interface TraceConfig {
    agentCli?: string;
}

async function readConfig(): Promise<TraceConfig> {
    try {
        const raw = await fs.readFile(traceConfigPath(), 'utf-8');
        return JSON.parse(raw) as TraceConfig;
    } catch {
        return {};
    }
}

async function writeConfig(config: TraceConfig): Promise<void> {
    const filePath = traceConfigPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
        filePath,
        `${JSON.stringify(config, null, 2)}\n`,
        'utf-8',
    );
}

async function isOnPath(bin: string): Promise<boolean> {
    try {
        await execa(process.platform === 'win32' ? 'where' : 'which', [bin]);
        return true;
    } catch {
        return false;
    }
}

export interface ResolvedAgentCli {
    spec: AgentCliSpec;
    /** True when the choice came from config rather than a fresh probe. */
    fromConfig: boolean;
}

export async function resolveAgentCli(
    override?: string,
): Promise<ResolvedAgentCli | null> {
    const envOverride = process.env.KODUS_TRACE_AGENT_CMD?.trim();
    if (envOverride) {
        const [bin, ...args] = envOverride.split(/\s+/);
        return { spec: { name: bin, bin, args }, fromConfig: false };
    }

    if (override) {
        const named = AGENT_CLI_PREFERENCE.find(
            (entry) => entry.name === override || entry.bin === override,
        );
        const spec = named ?? { name: override, bin: override, args: ['-p'] };
        return (await isOnPath(spec.bin)) ? { spec, fromConfig: false } : null;
    }

    const config = await readConfig();
    if (config.agentCli) {
        const remembered = AGENT_CLI_PREFERENCE.find(
            (entry) => entry.name === config.agentCli,
        );
        if (remembered && (await isOnPath(remembered.bin))) {
            return { spec: remembered, fromConfig: true };
        }
    }

    for (const spec of AGENT_CLI_PREFERENCE) {
        if (await isOnPath(spec.bin)) {
            await writeConfig({ ...config, agentCli: spec.name }).catch(
                () => {},
            );
            return { spec, fromConfig: false };
        }
    }

    return null;
}

/**
 * Run the resolved agent CLI with the prompt on stdin and return raw stdout.
 * Local distillation costs the developer nothing: no key management, no server
 * round trip, just the CLI they already have installed.
 */
export async function runAgentCli(
    spec: AgentCliSpec,
    prompt: string,
    options: { cwd: string; timeoutMs?: number } = { cwd: process.cwd() },
): Promise<string> {
    const result = await execa(spec.bin, spec.args, {
        cwd: options.cwd,
        input: prompt,
        timeout: options.timeoutMs ?? 180_000,
        reject: true,
        env: {
            ...process.env,
            // The agent CLI runs inside the repository, so it picks up the very
            // hooks this feature installed and its own distillation prompt is
            // captured as a session — which then feeds the next distillation.
            // This tells the hooks it is Kodus' own subprocess.
            KODUS_TRACE_SKIP: '1',
        },
    });
    return result.stdout;
}
