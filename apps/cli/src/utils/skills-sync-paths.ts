import fs from 'node:fs/promises';
import path from 'node:path';
import { assertValidSkillName } from './skills.js';
import type { SkillSyncTarget } from './skills-sync.js';

export function resolveManagedSkillPath(
    target: SkillSyncTarget,
    skillName: string,
): string {
    const safeSkillName = assertValidSkillName(skillName);
    const filePath =
        target.type === 'skill'
            ? path.join(target.baseDir, safeSkillName, 'SKILL.md')
            : path.join(target.baseDir, `${safeSkillName}.md`);

    const resolvedBaseDir = path.resolve(target.baseDir);
    const resolvedPath = path.resolve(filePath);
    const expectedPrefix = `${resolvedBaseDir}${path.sep}`;

    if (
        resolvedPath !== resolvedBaseDir &&
        !resolvedPath.startsWith(expectedPrefix)
    ) {
        throw new Error(`Invalid skill name: ${skillName}`);
    }

    return resolvedPath;
}

export function resolveManagedSkillEntryPath(
    target: SkillSyncTarget,
    skillName: string,
): string {
    const safeSkillName = assertValidSkillName(skillName);
    const filePath =
        target.type === 'skill'
            ? path.join(target.baseDir, safeSkillName)
            : path.join(target.baseDir, `${safeSkillName}.md`);

    const resolvedBaseDir = path.resolve(target.baseDir);
    const resolvedPath = path.resolve(filePath);
    const expectedPrefix = `${resolvedBaseDir}${path.sep}`;

    if (
        resolvedPath !== resolvedBaseDir &&
        !resolvedPath.startsWith(expectedPrefix)
    ) {
        throw new Error(`Invalid skill name: ${skillName}`);
    }

    return resolvedPath;
}

async function isDirectory(targetPath: string): Promise<boolean> {
    try {
        const stats = await fs.stat(targetPath);
        return stats.isDirectory();
    } catch {
        return false;
    }
}

async function isFile(targetPath: string): Promise<boolean> {
    try {
        const stats = await fs.stat(targetPath);
        return stats.isFile();
    } catch {
        return false;
    }
}

export async function removePathIfExists(
    targetPath: string,
    dryRun: boolean,
): Promise<boolean> {
    const exists =
        (await isDirectory(targetPath)) || (await isFile(targetPath));
    if (!exists) {
        return false;
    }

    if (!dryRun) {
        await fs.rm(targetPath, { recursive: true, force: true });
    }

    return true;
}
