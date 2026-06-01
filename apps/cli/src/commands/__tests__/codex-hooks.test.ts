import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
    installCodexNotify,
    removeCodexNotify,
    CODEX_NOTIFY_LINE,
    CODEX_NOTIFY_LINE_LEGACY,
    resolveCodexConfigPath,
} from '../memory/hooks.js';

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

describe('installCodexNotify', () => {
    it('creates config.toml with notify line when none exists', async () => {
        const result = await installCodexNotify(configPath());

        expect(result.changed).toBe(true);
        expect(result.skipped).toBe(false);

        const content = await fs.readFile(configPath(), 'utf-8');
        expect(content).toContain(CODEX_NOTIFY_LINE);
    });

    it('appends notify line to existing config', async () => {
        await fs.mkdir(path.dirname(configPath()), { recursive: true });
        await fs.writeFile(configPath(), 'model = "o3"\n');

        const result = await installCodexNotify(configPath());

        expect(result.changed).toBe(true);

        const content = await fs.readFile(configPath(), 'utf-8');
        expect(content).toContain('model = "o3"');
        expect(content).toContain(CODEX_NOTIFY_LINE);
    });

    it('is idempotent — does not duplicate notify line', async () => {
        await installCodexNotify(configPath());
        const result = await installCodexNotify(configPath());

        expect(result.changed).toBe(false);
        expect(result.skipped).toBe(false);

        const content = await fs.readFile(configPath(), 'utf-8');
        const matches = content.split(CODEX_NOTIFY_LINE).length - 1;
        expect(matches).toBe(1);
    });

    it('upgrades legacy notify line to current', async () => {
        await fs.mkdir(path.dirname(configPath()), { recursive: true });
        await fs.writeFile(
            configPath(),
            `model = "o3"\n${CODEX_NOTIFY_LINE_LEGACY}\n`,
        );

        const result = await installCodexNotify(configPath());

        expect(result.changed).toBe(true);

        const content = await fs.readFile(configPath(), 'utf-8');
        expect(content).toContain(CODEX_NOTIFY_LINE);
        expect(content).not.toContain(CODEX_NOTIFY_LINE_LEGACY);
    });

    it('skips when a different notify entry exists', async () => {
        await fs.mkdir(path.dirname(configPath()), { recursive: true });
        await fs.writeFile(configPath(), 'notify = ["some-other-tool"]\n');

        const result = await installCodexNotify(configPath());

        expect(result.changed).toBe(false);
        expect(result.skipped).toBe(true);
        expect(result.reason).toContain('notify');
    });
});

describe('removeCodexNotify', () => {
    it('removes notify line from config', async () => {
        await installCodexNotify(configPath());
        const result = await removeCodexNotify(configPath());

        expect(result.removed).toBe(true);

        const content = await fs.readFile(configPath(), 'utf-8');
        expect(content).not.toContain(CODEX_NOTIFY_LINE);
    });

    it('removes legacy notify line', async () => {
        await fs.mkdir(path.dirname(configPath()), { recursive: true });
        await fs.writeFile(
            configPath(),
            `model = "o3"\n${CODEX_NOTIFY_LINE_LEGACY}\n`,
        );

        const result = await removeCodexNotify(configPath());

        expect(result.removed).toBe(true);

        const content = await fs.readFile(configPath(), 'utf-8');
        expect(content).not.toContain(CODEX_NOTIFY_LINE_LEGACY);
        expect(content).toContain('model = "o3"');
    });

    it('returns removed=false when config does not exist', async () => {
        const result = await removeCodexNotify(configPath());
        expect(result.removed).toBe(false);
    });

    it('returns removed=false when no kodus notify present', async () => {
        await fs.mkdir(path.dirname(configPath()), { recursive: true });
        await fs.writeFile(configPath(), 'model = "o3"\n');

        const result = await removeCodexNotify(configPath());
        expect(result.removed).toBe(false);
    });
});

describe('resolveCodexConfigPath', () => {
    it('defaults to ~/.codex/config.toml', () => {
        const result = resolveCodexConfigPath();
        expect(result).toBe(path.join(os.homedir(), '.codex', 'config.toml'));
    });

    it('expands tilde in path', () => {
        const result = resolveCodexConfigPath('~/custom/config.toml');
        expect(result).toBe(path.join(os.homedir(), 'custom/config.toml'));
    });

    it('resolves absolute path as-is', () => {
        const result = resolveCodexConfigPath('/tmp/config.toml');
        expect(result).toBe('/tmp/config.toml');
    });
});
