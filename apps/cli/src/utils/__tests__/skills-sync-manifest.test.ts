import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillSyncTarget } from '../skills-sync.js';
import {
    readManagedSkillNames,
    resolveManagedManifestPath,
    writeManagedSkillNames,
} from '../skills-sync-manifest.js';

async function makeTempDir(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('skills sync manifest helpers', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(
            tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
        );
        tempDirs.length = 0;
    });

    it('resolves the managed manifest path inside the target base dir', () => {
        const target: SkillSyncTarget = {
            label: 'Codex test',
            type: 'skill',
            activationPath: '/tmp/.codex',
            baseDir: '/tmp/.codex/skills',
        };

        expect(resolveManagedManifestPath(target)).toBe(
            '/tmp/.codex/skills/.kodus-managed-skills.json',
        );
    });

    it('writes sorted skill names and reads only valid entries back', async () => {
        const tempRoot = await makeTempDir('kodus-skills-manifest-');
        tempDirs.push(tempRoot);

        const target: SkillSyncTarget = {
            label: 'Codex test',
            type: 'skill',
            activationPath: path.join(tempRoot, '.codex'),
            baseDir: path.join(tempRoot, '.codex', 'skills'),
        };

        await writeManagedSkillNames(
            target,
            ['kodus-review', 'z-last', 'a-first'],
            false,
        );

        const manifestRaw = await fs.readFile(
            resolveManagedManifestPath(target),
            'utf8',
        );
        expect(manifestRaw).toContain('"a-first"');
        expect(manifestRaw).toContain('"kodus-review"');
        expect(manifestRaw).toContain('"z-last"');

        await fs.writeFile(
            resolveManagedManifestPath(target),
            JSON.stringify(['kodus-review', '../evil', 42, 'a-first']),
            'utf8',
        );

        expect(await readManagedSkillNames(target)).toEqual([
            'kodus-review',
            'a-first',
        ]);
    });

    it('does not create files during dry run', async () => {
        const tempRoot = await makeTempDir('kodus-skills-manifest-dry-');
        tempDirs.push(tempRoot);

        const target: SkillSyncTarget = {
            label: 'Codex test',
            type: 'skill',
            activationPath: path.join(tempRoot, '.codex'),
            baseDir: path.join(tempRoot, '.codex', 'skills'),
        };

        await writeManagedSkillNames(target, ['kodus-review'], true);

        await expect(
            fs.access(resolveManagedManifestPath(target)),
        ).rejects.toThrow();
    });
});
