import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    readManagedSkillNames,
    resolveManagedManifestPath,
    writeManagedSkillNames,
} from './skills-sync-manifest.js';
import {
    removePathIfExists,
    resolveManagedSkillEntryPath,
    resolveManagedSkillPath,
} from './skills-sync-paths.js';
import { buildSkillSyncTargets } from './skills-sync-targets.js';
import { type BundledSkillDocument, readBundledSkills } from './skills.js';

export const DEFAULT_SYNC_SKILL_NAMES = [
    'kodus-review',
    'kodus-pr-suggestions-resolver',
    'kodus-business-rules-validation',
    'kodus-kody-rules',
    'kodus-centralized-config',
] as const;

const LEGACY_BUSINESS_RULES_NAME = 'business-rules-validation';

export type SkillTargetType = 'skill' | 'command';
export type SkillSyncMode = 'sync' | 'install' | 'uninstall';

export interface SkillSyncTarget {
    label: string;
    type: SkillTargetType;
    activationPath: string;
    baseDir: string;
}

export interface SkillSyncTargetResult {
    target: SkillSyncTarget;
    synced: boolean;
    created: number;
    updated: number;
    unchanged: number;
    removedManaged: number;
    removedLegacy: number;
    reason?: string;
}

export interface SkillSyncResult {
    results: SkillSyncTargetResult[];
    scannedTargets: number;
    syncedTargets: number;
    skippedTargets: number;
    createdFiles: number;
    updatedFiles: number;
    unchangedFiles: number;
    removedManagedEntries: number;
    removedLegacyEntries: number;
}

export interface SyncSkillOptions {
    dryRun?: boolean;
    mode?: SkillSyncMode;
    skills?: BundledSkillDocument[];
}

async function isDirectory(targetPath: string): Promise<boolean> {
    try {
        const stats = await fs.stat(targetPath);
        return stats.isDirectory();
    } catch {
        return false;
    }
}

type WriteStatus = 'created' | 'updated' | 'unchanged';

async function writeIfChanged(
    filePath: string,
    content: string,
    dryRun: boolean,
): Promise<WriteStatus> {
    let existingContent: string | null = null;
    try {
        existingContent = await fs.readFile(filePath, 'utf8');
    } catch {
        // File does not exist yet.
    }

    if (existingContent === content) {
        return 'unchanged';
    }

    if (dryRun) {
        return existingContent === null ? 'created' : 'updated';
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
    return existingContent === null ? 'created' : 'updated';
}

function resolveManagedSkillNestedFilePath(
    target: SkillSyncTarget,
    skillName: string,
    relativePath: string,
): string {
    if (target.type !== 'skill') {
        throw new Error(
            'Nested skill files are only supported for skill targets.',
        );
    }

    const normalizedRelativePath = path
        .normalize(relativePath)
        .replace(/^\.([/\\])/, '');
    if (
        !normalizedRelativePath ||
        normalizedRelativePath.startsWith('..') ||
        path.isAbsolute(normalizedRelativePath)
    ) {
        throw new Error(`Invalid skill file path: ${relativePath}`);
    }

    const skillRoot = resolveManagedSkillEntryPath(target, skillName);
    const resolvedPath = path.resolve(skillRoot, normalizedRelativePath);
    const relativeFromRoot = path.relative(skillRoot, resolvedPath);
    if (
        !relativeFromRoot ||
        relativeFromRoot === '.' ||
        relativeFromRoot.startsWith('..') ||
        path.isAbsolute(relativeFromRoot)
    ) {
        throw new Error(`Invalid skill file path: ${relativePath}`);
    }

    return resolvedPath;
}

function applyWriteStatus(
    result: SkillSyncTargetResult,
    writeStatus: WriteStatus,
): void {
    if (writeStatus === 'created') {
        result.created += 1;
        return;
    }
    if (writeStatus === 'updated') {
        result.updated += 1;
        return;
    }
    result.unchanged += 1;
}

function createSkippedTargetResult(
    target: SkillSyncTarget,
    reason: string,
): SkillSyncTargetResult {
    return {
        target,
        synced: false,
        created: 0,
        updated: 0,
        unchanged: 0,
        removedManaged: 0,
        removedLegacy: 0,
        reason,
    };
}

function createSyncedTargetResult(
    target: SkillSyncTarget,
): SkillSyncTargetResult {
    return {
        target,
        synced: true,
        created: 0,
        updated: 0,
        unchanged: 0,
        removedManaged: 0,
        removedLegacy: 0,
    };
}

export function buildDefaultSkillSyncTargets(
    cwd = process.cwd(),
    homeDir = os.homedir(),
): SkillSyncTarget[] {
    return buildSkillSyncTargets(cwd, homeDir);
}

async function loadSkillsForSync(
    skills?: BundledSkillDocument[],
): Promise<BundledSkillDocument[]> {
    if (skills) {
        return skills;
    }

    return readBundledSkills([...DEFAULT_SYNC_SKILL_NAMES]);
}

export async function syncSkillsToTargets(
    targets: SkillSyncTarget[],
    options: SyncSkillOptions = {},
): Promise<SkillSyncResult> {
    const dryRun = options.dryRun ?? false;
    const mode = options.mode ?? 'sync';
    const skills = await loadSkillsForSync(options.skills);
    const results: SkillSyncTargetResult[] = [];

    for (const target of targets) {
        const currentSkillNames = skills.map((skill) => skill.name);
        let hasTargetDirectory = await isDirectory(target.baseDir);
        if (mode === 'install' && !hasTargetDirectory) {
            const hasActivationPath = await isDirectory(target.activationPath);
            if (!hasActivationPath) {
                results.push(
                    createSkippedTargetResult(
                        target,
                        'Agent root directory not found.',
                    ),
                );
                continue;
            }

            if (!dryRun) {
                await fs.mkdir(target.baseDir, { recursive: true });
            }
            hasTargetDirectory = true;
        }

        if (!hasTargetDirectory) {
            results.push(
                createSkippedTargetResult(
                    target,
                    'Target directory not found.',
                ),
            );
            continue;
        }

        const targetResult = createSyncedTargetResult(target);
        const previouslyManagedSkillNames = await readManagedSkillNames(target);
        const currentSkillNamesSet = new Set(currentSkillNames);
        const staleManagedSkillNames = previouslyManagedSkillNames.filter(
            (skillName) => !currentSkillNamesSet.has(skillName),
        );

        if (mode === 'uninstall') {
            const uninstallSkillNames = Array.from(
                new Set([...currentSkillNames, ...previouslyManagedSkillNames]),
            );
            for (const skillName of uninstallSkillNames) {
                const filePath = resolveManagedSkillEntryPath(
                    target,
                    skillName,
                );
                if (await removePathIfExists(filePath, dryRun)) {
                    targetResult.removedManaged += 1;
                } else {
                    targetResult.unchanged += 1;
                }
            }
            await removePathIfExists(
                resolveManagedManifestPath(target),
                dryRun,
            );
        } else {
            for (const skill of skills) {
                if (target.type === 'command') {
                    const filePath = resolveManagedSkillPath(
                        target,
                        skill.name,
                    );
                    const writeStatus = await writeIfChanged(
                        filePath,
                        skill.content,
                        dryRun,
                    );
                    applyWriteStatus(targetResult, writeStatus);
                    continue;
                }

                const filesToSync =
                    skill.files && skill.files.length > 0
                        ? skill.files
                        : [
                              {
                                  relativePath: 'SKILL.md',
                                  content: skill.content,
                              },
                          ];

                for (const skillFile of filesToSync) {
                    const filePath = resolveManagedSkillNestedFilePath(
                        target,
                        skill.name,
                        skillFile.relativePath,
                    );
                    const writeStatus = await writeIfChanged(
                        filePath,
                        skillFile.content,
                        dryRun,
                    );
                    applyWriteStatus(targetResult, writeStatus);
                }
            }

            for (const skillName of staleManagedSkillNames) {
                const entryPath = resolveManagedSkillEntryPath(
                    target,
                    skillName,
                );
                if (await removePathIfExists(entryPath, dryRun)) {
                    targetResult.removedManaged += 1;
                }
            }

            await writeManagedSkillNames(target, currentSkillNames, dryRun);
        }

        const legacyPath =
            target.type === 'skill'
                ? path.join(target.baseDir, LEGACY_BUSINESS_RULES_NAME)
                : path.join(target.baseDir, `${LEGACY_BUSINESS_RULES_NAME}.md`);
        if (await removePathIfExists(legacyPath, dryRun)) {
            targetResult.removedLegacy += 1;
        }

        results.push(targetResult);
    }

    const syncedTargets = results.filter((result) => result.synced).length;
    return {
        results,
        scannedTargets: results.length,
        syncedTargets,
        skippedTargets: results.length - syncedTargets,
        createdFiles: results.reduce((sum, result) => sum + result.created, 0),
        updatedFiles: results.reduce((sum, result) => sum + result.updated, 0),
        unchangedFiles: results.reduce(
            (sum, result) => sum + result.unchanged,
            0,
        ),
        removedManagedEntries: results.reduce(
            (sum, result) => sum + result.removedManaged,
            0,
        ),
        removedLegacyEntries: results.reduce(
            (sum, result) => sum + result.removedLegacy,
            0,
        ),
    };
}
