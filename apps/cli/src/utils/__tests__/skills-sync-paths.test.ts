import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillSyncTarget } from '../skills-sync.js';
import {
    removePathIfExists,
    resolveManagedSkillEntryPath,
    resolveManagedSkillPath,
} from '../skills-sync-paths.js';

async function makeTempDir(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('skills sync path helpers', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(
            tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
        );
        tempDirs.length = 0;
    });

    const skillTarget: SkillSyncTarget = {
        label: 'Codex test',
        type: 'skill',
        activationPath: '/tmp/.codex',
        baseDir: '/tmp/.codex/skills',
    };

    const commandTarget: SkillSyncTarget = {
        label: 'Claude test',
        type: 'command',
        activationPath: '/tmp/.claude',
        baseDir: '/tmp/.claude/commands',
    };

    it('resolves skill and command paths inside the target base dir', () => {
        expect(resolveManagedSkillPath(skillTarget, 'kodus-review')).toBe(
            '/tmp/.codex/skills/kodus-review/SKILL.md',
        );
        expect(resolveManagedSkillEntryPath(commandTarget, 'kodus-review')).toBe(
            '/tmp/.claude/commands/kodus-review.md',
        );
    });

    it('rejects skill names that escape the base dir', () => {
        expect(() =>
            resolveManagedSkillPath(skillTarget, '../evil'),
        ).toThrow('Invalid skill name');
        expect(() =>
            resolveManagedSkillEntryPath(commandTarget, '../evil'),
        ).toThrow('Invalid skill name');
    });

    it('removes an existing path and reports whether it existed', async () => {
        const tempRoot = await makeTempDir('kodus-skills-paths-');
        tempDirs.push(tempRoot);

        const targetPath = path.join(tempRoot, 'skill-dir');
        await fs.mkdir(targetPath, { recursive: true });

        await expect(removePathIfExists(targetPath, false)).resolves.toBe(true);
        await expect(fs.access(targetPath)).rejects.toThrow();
        await expect(removePathIfExists(targetPath, false)).resolves.toBe(false);
    });

    it('does not remove files during dry run', async () => {
        const tempRoot = await makeTempDir('kodus-skills-paths-dry-');
        tempDirs.push(tempRoot);

        const targetPath = path.join(tempRoot, 'skill-dir');
        await fs.mkdir(targetPath, { recursive: true });

        await expect(removePathIfExists(targetPath, true)).resolves.toBe(true);
        await fs.access(targetPath);
    });
});
