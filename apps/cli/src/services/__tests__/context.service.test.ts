import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextService } from '../context.service.js';

describe('ContextService', () => {
    let tmpDir: string | undefined;
    let originalCwd: string | undefined;

    afterEach(async () => {
        if (originalCwd) {
            process.chdir(originalCwd);
            originalCwd = undefined;
        }
        if (tmpDir) {
            await fs.rm(tmpDir, { recursive: true, force: true });
            tmpDir = undefined;
        }
    });

    it('reads context files using injected repository root resolver', async () => {
        tmpDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-context-test-'),
        );
        await fs.writeFile(path.join(tmpDir, '.cursorrules'), 'cursor rules');
        await fs.writeFile(path.join(tmpDir, 'claude.md'), 'claude rules');
        await fs.mkdir(path.join(tmpDir, '.kodus'), { recursive: true });
        await fs.writeFile(
            path.join(tmpDir, '.kodus', 'rules.md'),
            'kodus rules',
        );

        const contextService = new ContextService(async () => tmpDir!);
        const context = await contextService.readProjectContext();

        expect(context.cursorRules).toBe('cursor rules');
        expect(context.claudeRules).toBe('claude rules');
        expect(context.kodusRules).toBe('kodus rules');
    });

    it('falls back to process cwd when repository root resolver fails', async () => {
        tmpDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-context-fallback-test-'),
        );
        await fs.writeFile(path.join(tmpDir, '.cursorrules'), 'cwd rules');

        originalCwd = process.cwd();
        process.chdir(tmpDir);

        const contextService = new ContextService(async () => {
            throw new Error('git unavailable');
        });

        const context = await contextService.readProjectContext();
        expect(context.cursorRules).toBe('cwd rules');
    });
});
