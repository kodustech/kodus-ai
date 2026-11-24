import { tool, type Tool } from 'ai';

import type { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';

import { buildNativeToolConfigs } from '../agents/native-tools.factory';

/**
 * Wrap the sandbox-backed native tool configs (grep, readFile, listDir, exec)
 * as Vercel AI SDK tools — the replacement for registering them on a
 * legacy flow-engine orchestration via `orchestration.createTool(cfg)`.
 *
 * `buildNativeToolConfigs` already returns AI-SDK-shaped entries
 * (`{ name, description, inputSchema: ZodSchema, execute }`); the AI SDK accepts
 * a Zod schema directly as `inputSchema`, so this is a thin adapter. The
 * sandbox opens on the first call (`buildNativeToolConfigs`).
 */
export function buildNativeTools(
    openSandbox: () => Promise<SandboxInstance>,
): Record<string, Tool> {
    const tools: Record<string, Tool> = {};
    for (const cfg of buildNativeToolConfigs(openSandbox)) {
        tools[cfg.name] = tool({
            description: cfg.description,
            inputSchema: cfg.inputSchema,
            execute: (args: unknown) => cfg.execute(args),
        });
    }
    return tools;
}
