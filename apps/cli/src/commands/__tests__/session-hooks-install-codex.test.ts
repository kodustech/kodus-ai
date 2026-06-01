import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
    installCodexSessionHooks,
    removeCodexSessionHooks,
} from '../memory/session-hooks-install-codex.js';

let tmpDir: string;

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'kodus-codex-hooks-'),
    );
});

afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
});

function configPath(): string {
    return path.join(tmpDir, 'config.toml');
}

describe('installCodexSessionHooks', () => {
    it('creates config.toml with [[hooks]] blocks', async () => {
        const result = await installCodexSessionHooks(configPath());

        expect(result.changed).toBe(true);
        expect(result.configPath).toBe(configPath());

        const content = await fs.readFile(configPath(), 'utf-8');
        expect(content).toContain('[[hooks]]');
        expect(content).toContain('event = "AfterAgent"');
    });

    it('sets correct command for AfterAgent hook', async () => {
        await installCodexSessionHooks(configPath());

        const content = await fs.readFile(configPath(), 'utf-8');
        expect(content).toContain(
            'command = "kodus decisions hooks codex AfterAgent"',
        );
    });

    it('is idempotent — second install returns changed=false', async () => {
        await installCodexSessionHooks(configPath());
        const result = await installCodexSessionHooks(configPath());

        expect(result.changed).toBe(false);

        // Content should not be duplicated
        const content = await fs.readFile(configPath(), 'utf-8');
        const hookBlocks = content.match(/\[\[hooks\]\]/g);
        expect(hookBlocks).toHaveLength(1);
    });

    it('preserves existing TOML content', async () => {
        await fs.mkdir(tmpDir, { recursive: true });
        await fs.writeFile(
            configPath(),
            '[settings]\nmodel = "gpt-4"\n',
        );

        await installCodexSessionHooks(configPath());

        const content = await fs.readFile(configPath(), 'utf-8');
        expect(content).toContain('[settings]');
        expect(content).toContain('model = "gpt-4"');
        expect(content).toContain('[[hooks]]');
        expect(content).toContain(
            'command = "kodus decisions hooks codex AfterAgent"',
        );
    });
});

describe('removeCodexSessionHooks', () => {
    it('removes kodus hooks', async () => {
        await installCodexSessionHooks(configPath());
        const result = await removeCodexSessionHooks(configPath());

        expect(result.removed).toBe(true);

        const content = await fs.readFile(configPath(), 'utf-8');
        expect(content).not.toContain('kodus decisions hooks codex');
        expect(content).not.toContain('[[hooks]]');
    });

    it('returns removed=false when no config file', async () => {
        const result = await removeCodexSessionHooks(configPath());
        expect(result.removed).toBe(false);
    });

    it('preserves non-kodus hooks and content', async () => {
        await fs.mkdir(tmpDir, { recursive: true });

        const existingContent = [
            '[settings]',
            'model = "gpt-4"',
            '',
            '[[hooks]]',
            'event = "BeforeAgent"',
            'command = "echo before-agent"',
            '',
        ].join('\n');

        await fs.writeFile(configPath(), existingContent);

        // Install kodus hooks (appends a new [[hooks]] block)
        await installCodexSessionHooks(configPath());

        // Verify both hook blocks are present
        const contentBefore = await fs.readFile(configPath(), 'utf-8');
        expect(contentBefore).toContain('echo before-agent');
        expect(contentBefore).toContain('kodus decisions hooks codex');

        // Remove kodus hooks
        const result = await removeCodexSessionHooks(configPath());
        expect(result.removed).toBe(true);

        const contentAfter = await fs.readFile(configPath(), 'utf-8');

        // Non-kodus content should remain
        expect(contentAfter).toContain('[settings]');
        expect(contentAfter).toContain('model = "gpt-4"');
        expect(contentAfter).toContain('[[hooks]]');
        expect(contentAfter).toContain('echo before-agent');

        // Kodus hooks should be gone
        expect(contentAfter).not.toContain('kodus decisions hooks codex');
    });
});
