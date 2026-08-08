import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
    installCodexSessionHooks,
    removeCodexSessionHooks,
} from '../trace/session-hooks-install-codex.js';
import { resolveCodexConfigPath } from '../trace/hooks.js';

let tmpDir: string;

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodus-codex-test-'));
});

afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
});

function configPath(): string {
    return path.join(tmpDir, '.codex', 'config.toml');
}

describe('installCodexSessionHooks', () => {
    it('creates config.toml with session hook when none exists', async () => {
        const result = await installCodexSessionHooks(configPath());

        expect(result.changed).toBe(true);

        const content = await fs.readFile(configPath(), 'utf-8');
        expect(content).toContain('kodus trace hooks codex');
        expect(content).not.toContain('kodus decisions');
    });

    it('is idempotent', async () => {
        await installCodexSessionHooks(configPath());
        const result = await installCodexSessionHooks(configPath());
        expect(result.changed).toBe(false);
    });

    it('migrates legacy decisions hooks marker', async () => {
        await fs.mkdir(path.dirname(configPath()), { recursive: true });
        await fs.writeFile(
            configPath(),
            [
                '[[hooks]]',
                'event = "AfterAgent"',
                'command = "kodus decisions hooks codex AfterAgent"',
                '',
            ].join('\n'),
            'utf-8',
        );

        const result = await installCodexSessionHooks(configPath());
        expect(result.changed).toBe(true);
        const content = await fs.readFile(configPath(), 'utf-8');
        expect(content).toContain('kodus trace hooks codex');
        expect(content).not.toContain('kodus decisions');
    });
});

describe('removeCodexSessionHooks', () => {
    it('removes installed hooks', async () => {
        await installCodexSessionHooks(configPath());
        const result = await removeCodexSessionHooks(configPath());
        expect(result.removed).toBe(true);
        const content = await fs.readFile(configPath(), 'utf-8');
        expect(content).not.toContain('kodus trace hooks codex');
    });
});

describe('resolveCodexConfigPath', () => {
    it('defaults to ~/.codex/config.toml', () => {
        const p = resolveCodexConfigPath();
        expect(p).toContain('.codex');
        expect(p.endsWith('config.toml')).toBe(true);
    });
});
