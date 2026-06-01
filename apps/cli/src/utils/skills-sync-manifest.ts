import fs from 'node:fs/promises';
import path from 'node:path';
import { assertValidSkillName } from './skills.js';
import type { SkillSyncTarget } from './skills-sync.js';

const MANAGED_SKILLS_MANIFEST = '.kodus-managed-skills.json';

export function resolveManagedManifestPath(target: SkillSyncTarget): string {
    return path.join(target.baseDir, MANAGED_SKILLS_MANIFEST);
}

export async function readManagedSkillNames(
    target: SkillSyncTarget,
): Promise<string[]> {
    try {
        const raw = await fs.readFile(resolveManagedManifestPath(target), 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed
            .filter((value): value is string => typeof value === 'string')
            .map((value) => {
                try {
                    return assertValidSkillName(value);
                } catch {
                    return null;
                }
            })
            .filter((value): value is string => value !== null);
    } catch {
        return [];
    }
}

export async function writeManagedSkillNames(
    target: SkillSyncTarget,
    skillNames: string[],
    dryRun: boolean,
): Promise<void> {
    if (dryRun) {
        return;
    }

    const manifestPath = resolveManagedManifestPath(target);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(
        manifestPath,
        `${JSON.stringify(skillNames.sort(), null, 2)}\n`,
        'utf8',
    );
}
