import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    buildDefaultSkillSyncTargets,
    DEFAULT_SYNC_SKILL_NAMES,
    syncSkillsToTargets,
    type SkillSyncTarget,
} from '../skills-sync.js';

async function makeTempDir(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function exists(targetPath: string): Promise<boolean> {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

describe('skills-sync utilities', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(
            tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
        );
        tempDirs.length = 0;
    });

    it('builds deterministic default sync targets', () => {
        const targets = buildDefaultSkillSyncTargets(
            '/repo/workspace',
            '/users/demo',
        );
        expect(targets).toContainEqual({
            label: 'Codex project skills',
            type: 'skill',
            activationPath: '/repo/workspace/.codex',
            baseDir: '/repo/workspace/.codex/skills',
        });
        expect(targets).toContainEqual({
            label: 'Claude user commands',
            type: 'command',
            activationPath: '/users/demo/.claude',
            baseDir: '/users/demo/.claude/commands',
        });
        expect(targets).toContainEqual({
            label: 'OpenCode project skills',
            type: 'skill',
            activationPath: '/repo/workspace/.opencode',
            baseDir: '/repo/workspace/.opencode/skill',
        });
        expect(targets).toContainEqual({
            label: 'AiderDesk user commands',
            type: 'command',
            activationPath: '/users/demo/.aider-desk',
            baseDir: '/users/demo/.aider-desk/commands',
        });
        expect(targets).toContainEqual({
            label: 'Windsurf user skills',
            type: 'skill',
            activationPath: '/users/demo/.codeium/windsurf',
            baseDir: '/users/demo/.codeium/windsurf/skills',
        });
        expect(targets).toContainEqual({
            label: 'Kiro project skills',
            type: 'skill',
            activationPath: '/repo/workspace/.kiro',
            baseDir: '/repo/workspace/.kiro/skills',
        });
    });

    it('includes centralized config in default synced skill names', () => {
        expect(DEFAULT_SYNC_SKILL_NAMES).toContain('kodus-centralized-config');
    });

    it('syncs skill and command targets and removes legacy entries', async () => {
        const tempRoot = await makeTempDir('kodus-skills-sync-');
        tempDirs.push(tempRoot);

        const skillBaseDir = path.join(tempRoot, '.codex', 'skills');
        const commandBaseDir = path.join(tempRoot, '.claude', 'commands');
        await fs.mkdir(skillBaseDir, { recursive: true });
        await fs.mkdir(commandBaseDir, { recursive: true });

        await fs.mkdir(path.join(skillBaseDir, 'business-rules-validation'), {
            recursive: true,
        });
        await fs.writeFile(
            path.join(commandBaseDir, 'business-rules-validation.md'),
            'legacy',
            'utf8',
        );

        const targets: SkillSyncTarget[] = [
            {
                label: 'Codex test',
                type: 'skill',
                activationPath: path.join(tempRoot, '.codex'),
                baseDir: skillBaseDir,
            },
            {
                label: 'Claude test',
                type: 'command',
                activationPath: path.join(tempRoot, '.claude'),
                baseDir: commandBaseDir,
            },
        ];
        const result = await syncSkillsToTargets(targets, {
            skills: [
                { name: 'kodus-review', content: 'review skill content' },
                {
                    name: 'kodus-business-rules-validation',
                    content: 'business validation content',
                },
            ],
        });

        expect(result.syncedTargets).toBe(2);
        expect(result.createdFiles).toBe(4);
        expect(result.updatedFiles).toBe(0);
        expect(result.removedLegacyEntries).toBe(2);

        expect(
            await exists(path.join(skillBaseDir, 'kodus-review', 'SKILL.md')),
        ).toBe(true);
        expect(
            await exists(
                path.join(
                    skillBaseDir,
                    'kodus-business-rules-validation',
                    'SKILL.md',
                ),
            ),
        ).toBe(true);
        expect(await exists(path.join(commandBaseDir, 'kodus-review.md'))).toBe(
            true,
        );
        expect(
            await exists(
                path.join(commandBaseDir, 'kodus-business-rules-validation.md'),
            ),
        ).toBe(true);

        expect(
            await exists(path.join(skillBaseDir, 'business-rules-validation')),
        ).toBe(false);
        expect(
            await exists(
                path.join(commandBaseDir, 'business-rules-validation.md'),
            ),
        ).toBe(false);
    });

    it('supports dry-run without mutating files', async () => {
        const tempRoot = await makeTempDir('kodus-skills-sync-dry-');
        tempDirs.push(tempRoot);

        const skillBaseDir = path.join(tempRoot, '.codex', 'skills');
        await fs.mkdir(skillBaseDir, { recursive: true });
        await fs.mkdir(path.join(skillBaseDir, 'business-rules-validation'), {
            recursive: true,
        });

        const result = await syncSkillsToTargets(
            [
                {
                    label: 'Codex dry-run',
                    type: 'skill',
                    activationPath: path.join(tempRoot, '.codex'),
                    baseDir: skillBaseDir,
                },
            ],
            {
                dryRun: true,
                skills: [{ name: 'kodus-review', content: 'review skill' }],
            },
        );

        expect(result.syncedTargets).toBe(1);
        expect(result.createdFiles).toBe(1);
        expect(result.removedLegacyEntries).toBe(1);
        expect(
            await exists(path.join(skillBaseDir, 'kodus-review', 'SKILL.md')),
        ).toBe(false);
        expect(
            await exists(path.join(skillBaseDir, 'business-rules-validation')),
        ).toBe(true);
    });

    it('installs into detected activation path even when target dir is missing', async () => {
        const tempRoot = await makeTempDir('kodus-skills-install-');
        tempDirs.push(tempRoot);

        const activationPath = path.join(tempRoot, '.codex');
        const baseDir = path.join(activationPath, 'skills');
        await fs.mkdir(activationPath, { recursive: true });

        const result = await syncSkillsToTargets(
            [
                {
                    label: 'Codex install',
                    type: 'skill',
                    activationPath,
                    baseDir,
                },
            ],
            {
                mode: 'install',
                skills: [{ name: 'kodus-review', content: 'review skill' }],
            },
        );

        expect(result.syncedTargets).toBe(1);
        expect(result.createdFiles).toBe(1);
        expect(
            await exists(path.join(baseDir, 'kodus-review', 'SKILL.md')),
        ).toBe(true);
    });

    it('uninstalls managed skills from target directory', async () => {
        const tempRoot = await makeTempDir('kodus-skills-uninstall-');
        tempDirs.push(tempRoot);

        const baseDir = path.join(tempRoot, '.codex', 'skills');
        await fs.mkdir(path.join(baseDir, 'kodus-review'), { recursive: true });
        await fs.mkdir(path.join(baseDir, 'kodus-business-rules-validation'), {
            recursive: true,
        });
        await fs.mkdir(path.join(baseDir, 'business-rules-validation'), {
            recursive: true,
        });
        await fs.writeFile(
            path.join(baseDir, 'kodus-review', 'SKILL.md'),
            'content',
            'utf8',
        );
        await fs.writeFile(
            path.join(baseDir, 'kodus-business-rules-validation', 'SKILL.md'),
            'content',
            'utf8',
        );

        const result = await syncSkillsToTargets(
            [
                {
                    label: 'Codex uninstall',
                    type: 'skill',
                    activationPath: path.join(tempRoot, '.codex'),
                    baseDir,
                },
            ],
            {
                mode: 'uninstall',
                skills: [
                    { name: 'kodus-review', content: '' },
                    { name: 'kodus-business-rules-validation', content: '' },
                ],
            },
        );

        expect(result.syncedTargets).toBe(1);
        expect(result.removedManagedEntries).toBe(2);
        expect(result.removedLegacyEntries).toBe(1);
        expect(await exists(path.join(baseDir, 'kodus-review'))).toBe(false);
        expect(
            await exists(path.join(baseDir, 'kodus-business-rules-validation')),
        ).toBe(false);
        expect(
            await exists(path.join(baseDir, 'business-rules-validation')),
        ).toBe(false);
    });

    it('install mirrors the current bundled skill set on repeat runs', async () => {
        const tempRoot = await makeTempDir('kodus-skills-reinstall-');
        tempDirs.push(tempRoot);

        const activationPath = path.join(tempRoot, '.codex');
        const baseDir = path.join(activationPath, 'skills');
        await fs.mkdir(activationPath, { recursive: true });

        await syncSkillsToTargets(
            [
                {
                    label: 'Codex reinstall',
                    type: 'skill',
                    activationPath,
                    baseDir,
                },
            ],
            {
                mode: 'install',
                skills: [
                    { name: 'kodus-review', content: 'review v1' },
                    {
                        name: 'kodus-business-rules-validation',
                        content: 'business v1',
                    },
                ],
            },
        );

        const result = await syncSkillsToTargets(
            [
                {
                    label: 'Codex reinstall',
                    type: 'skill',
                    activationPath,
                    baseDir,
                },
            ],
            {
                mode: 'install',
                skills: [{ name: 'kodus-review', content: 'review v2' }],
            },
        );

        expect(result.syncedTargets).toBe(1);
        expect(result.updatedFiles).toBe(1);
        expect(result.removedManagedEntries).toBe(1);
        expect(
            await exists(
                path.join(
                    baseDir,
                    'kodus-business-rules-validation',
                    'SKILL.md',
                ),
            ),
        ).toBe(false);
        expect(
            await fs.readFile(
                path.join(baseDir, 'kodus-review', 'SKILL.md'),
                'utf8',
            ),
        ).toBe('review v2');
    });

    it('syncs nested subskill files for skill targets', async () => {
        const tempRoot = await makeTempDir('kodus-skills-nested-');
        tempDirs.push(tempRoot);

        const activationPath = path.join(tempRoot, '.codex');
        const baseDir = path.join(activationPath, 'skills');
        await fs.mkdir(baseDir, { recursive: true });

        const result = await syncSkillsToTargets(
            [
                {
                    label: 'Codex nested files',
                    type: 'skill',
                    activationPath,
                    baseDir,
                },
            ],
            {
                mode: 'install',
                skills: [
                    {
                        name: 'kodus-kody-rules',
                        content: 'root skill',
                        files: [
                            {
                                relativePath: 'SKILL.md',
                                content: 'root skill',
                            },
                            {
                                relativePath: 'rules/view-kody-rules.md',
                                content: 'nested rule doc',
                            },
                        ],
                    },
                ],
            },
        );

        expect(result.syncedTargets).toBe(1);
        expect(result.createdFiles).toBe(2);
        expect(
            await exists(path.join(baseDir, 'kodus-kody-rules', 'SKILL.md')),
        ).toBe(true);
        expect(
            await exists(
                path.join(
                    baseDir,
                    'kodus-kody-rules',
                    'rules',
                    'view-kody-rules.md',
                ),
            ),
        ).toBe(true);
    });

    it('rejects skill names that escape the target directory', async () => {
        const tempRoot = await makeTempDir('kodus-skills-invalid-');
        tempDirs.push(tempRoot);

        const baseDir = path.join(tempRoot, '.codex', 'skills');
        await fs.mkdir(baseDir, { recursive: true });

        await expect(
            syncSkillsToTargets(
                [
                    {
                        label: 'Codex invalid',
                        type: 'skill',
                        activationPath: path.join(tempRoot, '.codex'),
                        baseDir,
                    },
                ],
                {
                    skills: [{ name: '../evil', content: 'bad' }],
                },
            ),
        ).rejects.toThrow('Invalid skill name');
    });

    it('rejects nested skill file paths that resolve to the skill root', async () => {
        const tempRoot = await makeTempDir('kodus-skills-invalid-path-');
        tempDirs.push(tempRoot);

        const baseDir = path.join(tempRoot, '.codex', 'skills');
        await fs.mkdir(baseDir, { recursive: true });

        await expect(
            syncSkillsToTargets(
                [
                    {
                        label: 'Codex invalid file path',
                        type: 'skill',
                        activationPath: path.join(tempRoot, '.codex'),
                        baseDir,
                    },
                ],
                {
                    skills: [
                        {
                            name: 'kodus-review',
                            content: 'root',
                            files: [
                                {
                                    relativePath: '.',
                                    content: 'invalid',
                                },
                            ],
                        },
                    ],
                },
            ),
        ).rejects.toThrow('Invalid skill file path');
    });
});
