/**
 * Loads the Claude Agent SDK, lazily, on the first eligible call — a worker
 * that never serves a Claude slot never loads it.
 *
 * The package is ESM-only. Node ≥22.12 loads it with `require` (the image runs
 * 22.22, and webpack leaves node_modules external); Jest compiles its `.mjs`
 * (jest.config.ts). Zod is required next to it, so the tool schemas the bridge
 * builds are instances of the zod the SDK validates with.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export interface SdkRuntime {
    query: (args: { prompt: unknown; options?: Record<string, unknown> }) => AsyncIterable<any> & { close?: () => void; interrupt?: () => Promise<void> };
    tool: (name: string, description: string, shape: Record<string, unknown>, handler: (args: any, extra: unknown) => Promise<any>, extras?: Record<string, unknown>) => unknown;
    createSdkMcpServer: (opts: { name: string; version?: string; tools?: unknown[] }) => unknown;
    z: any;
    version: string;
}

let cached: SdkRuntime | undefined;

export function loadSdkRuntime(): SdkRuntime {
    if (cached) return cached;
    const sdk = require('@anthropic-ai/claude-agent-sdk');
    const zod = require('zod');
    cached = { query: sdk.query, tool: sdk.tool, createSdkMcpServer: sdk.createSdkMcpServer, z: zod.z ?? zod, version: sdkVersion() };
    return cached;
}

/** For traces. package.json is not in the package's exports map, so it is read
 *  next to the resolved entry (resolved by Node: webpack rewrites `require.resolve`). */
function sdkVersion(): string {
    try {
        const entry = createRequire(path.join(process.cwd(), 'package.json')).resolve('@anthropic-ai/claude-agent-sdk');
        return JSON.parse(readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8')).version as string;
    } catch {
        return 'unknown';
    }
}

