import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
    installCursorSessionHooks,
    removeCursorSessionHooks,
} from '../memory/session-hooks-install-cursor.js';

let tmpDir: string;

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'kodus-cursor-hooks-'),
    );
});

afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
});

function hooksPath(): string {
    return path.join(tmpDir, '.cursor', 'hooks.json');
}

async function readHooksConfig(): Promise<Record<string, unknown>> {
    const raw = await fs.readFile(hooksPath(), 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
}

describe('installCursorSessionHooks', () => {
    it('creates .cursor/hooks.json with correct structure', async () => {
        const result = await installCursorSessionHooks(tmpDir);

        expect(result.changed).toBe(true);
        expect(result.settingsPath).toBe(hooksPath());

        const config = await readHooksConfig();
        expect(config.version).toBe(1);
        expect(config.hooks).toBeDefined();

        const hooks = config.hooks as Record<string, unknown>;
        expect(hooks['sessionStart']).toBeDefined();
        expect(hooks['sessionEnd']).toBeDefined();
        expect(hooks['stop']).toBeDefined();
        expect(hooks['beforeSubmitPrompt']).toBeDefined();
        expect(hooks['subagentStart']).toBeDefined();
        expect(hooks['subagentStop']).toBeDefined();
    });

    it('sets correct commands for each hook event', async () => {
        await installCursorSessionHooks(tmpDir);

        const config = await readHooksConfig();
        const hooks = config.hooks as Record<
            string,
            Array<{ command: string }>
        >;

        expect(hooks['sessionStart'][0].command).toBe(
            'kodus decisions hooks cursor sessionStart',
        );
        expect(hooks['sessionEnd'][0].command).toBe(
            'kodus decisions hooks cursor sessionEnd',
        );
        expect(hooks['stop'][0].command).toBe(
            'kodus decisions hooks cursor stop',
        );
        expect(hooks['beforeSubmitPrompt'][0].command).toBe(
            'kodus decisions hooks cursor beforeSubmitPrompt',
        );
        expect(hooks['subagentStart'][0].command).toBe(
            'kodus decisions hooks cursor subagentStart',
        );
        expect(hooks['subagentStop'][0].command).toBe(
            'kodus decisions hooks cursor subagentStop',
        );
    });

    it('is idempotent — second install returns changed=false', async () => {
        await installCursorSessionHooks(tmpDir);
        const result = await installCursorSessionHooks(tmpDir);

        expect(result.changed).toBe(false);
    });

    it('preserves existing hooks in the file', async () => {
        await fs.mkdir(path.join(tmpDir, '.cursor'), { recursive: true });
        await fs.writeFile(
            hooksPath(),
            JSON.stringify(
                {
                    version: 1,
                    hooks: {
                        sessionStart: [{ command: 'echo custom-hook' }],
                    },
                },
                null,
                2,
            ),
        );

        await installCursorSessionHooks(tmpDir);

        const config = await readHooksConfig();
        const hooks = config.hooks as Record<
            string,
            Array<{ command: string }>
        >;

        // The existing custom hook should still be there
        const sessionStartCommands = hooks['sessionStart'].map(
            (e) => e.command,
        );
        expect(sessionStartCommands).toContain('echo custom-hook');
        expect(sessionStartCommands).toContain(
            'kodus decisions hooks cursor sessionStart',
        );
    });
});

describe('removeCursorSessionHooks', () => {
    it('removes all kodus hooks', async () => {
        await installCursorSessionHooks(tmpDir);
        const result = await removeCursorSessionHooks(tmpDir);

        expect(result.removed).toBe(true);

        const config = await readHooksConfig();
        const hooks = config.hooks as Record<string, unknown>;

        // All hook events should be removed (they only contained kodus entries)
        expect(Object.keys(hooks)).toHaveLength(0);
    });

    it('returns removed=false when no settings file', async () => {
        const result = await removeCursorSessionHooks(tmpDir);
        expect(result.removed).toBe(false);
    });

    it('preserves non-kodus hooks', async () => {
        // Install kodus hooks first
        await installCursorSessionHooks(tmpDir);

        // Add a non-kodus hook alongside the kodus one
        const config = await readHooksConfig();
        const hooks = config.hooks as Record<
            string,
            Array<{ command: string }>
        >;
        hooks['sessionStart'].push({ command: 'echo custom-hook' });
        await fs.writeFile(hooksPath(), JSON.stringify(config, null, 2));

        // Remove kodus hooks
        const result = await removeCursorSessionHooks(tmpDir);
        expect(result.removed).toBe(true);

        const after = await readHooksConfig();
        const afterHooks = after.hooks as Record<
            string,
            Array<{ command: string }>
        >;

        // The custom hook should remain
        expect(afterHooks['sessionStart']).toHaveLength(1);
        expect(afterHooks['sessionStart'][0].command).toBe(
            'echo custom-hook',
        );

        // Other event keys (which only had kodus hooks) should be removed
        expect(afterHooks['sessionEnd']).toBeUndefined();
    });
});
