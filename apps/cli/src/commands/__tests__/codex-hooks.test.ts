import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
    removeCodexNotify,
    CODEX_NOTIFY_LINE_LEGACY_VARIANTS,
    resolveCodexConfigPath,
} from '../trace/hooks.js';

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

async function writeConfig(content: string): Promise<void> {
    await fs.mkdir(path.dirname(configPath()), { recursive: true });
    await fs.writeFile(configPath(), content, 'utf-8');
}

/**
 * `notify` was the transport for the duplicate capture pipeline, which is gone.
 * Codex lifecycle capture now runs through `[[hooks]]`, so the only thing left
 * to do with a legacy `kodus decisions` notify line is remove it. Other Kodus
 * commands have separate ownership and must be preserved.
 */
describe('removeCodexNotify', () => {
    for (const [
        index,
        legacyLine,
    ] of CODEX_NOTIFY_LINE_LEGACY_VARIANTS.entries()) {
        it(`removes legacy notify variant ${index}`, async () => {
            await writeConfig(`model = "o3"\n${legacyLine}\n`);

            const result = await removeCodexNotify(configPath());

            expect(result.removed).toBe(true);

            const content = await fs.readFile(configPath(), 'utf-8');
            expect(content).not.toContain('notify =');
            expect(content).toContain('model = "o3"');
        });
    }

    it('preserves a Kodus notify line owned by another feature', async () => {
        await writeConfig(
            'model = "o3"\nnotify = ["kodus", "something", "new"]\n',
        );

        const result = await removeCodexNotify(configPath());

        expect(result.removed).toBe(false);
        const content = await fs.readFile(configPath(), 'utf-8');
        expect(content).toContain('notify = ["kodus", "something", "new"]');
    });

    it('leaves another tool’s notify entry alone', async () => {
        await writeConfig('notify = ["some-other-tool"]\n');

        const result = await removeCodexNotify(configPath());

        expect(result.removed).toBe(false);
        const content = await fs.readFile(configPath(), 'utf-8');
        expect(content).toContain('notify = ["some-other-tool"]');
    });

    it('returns removed=false when config does not exist', async () => {
        const result = await removeCodexNotify(configPath());
        expect(result.removed).toBe(false);
    });

    it('returns removed=false when no kodus notify present', async () => {
        await writeConfig('model = "o3"\n');

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
