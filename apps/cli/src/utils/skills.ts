import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BundledSkillDocument {
    name: string;
    content: string;
    files?: {
        relativePath: string;
        content: string;
    }[];
}

export function assertValidSkillName(name: string): string {
    const trimmed = name.trim();
    if (
        !trimmed ||
        trimmed === '.' ||
        trimmed === '..' ||
        trimmed.includes('/') ||
        trimmed.includes('\\') ||
        path.basename(trimmed) !== trimmed
    ) {
        throw new Error(`Invalid skill name: ${name}`);
    }

    return trimmed;
}

function resolveSkillsCandidates(): string[] {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return [
        path.resolve(here, '../../skills'),
        path.resolve(here, '../skills'),
    ];
}

async function resolveBundledSkillsRoot(): Promise<string | null> {
    for (const dir of resolveSkillsCandidates()) {
        try {
            await fs.access(dir);
            return dir;
        } catch {
            // Try next candidate.
        }
    }

    return null;
}

export async function listBundledSkills(): Promise<string[]> {
    const root = await resolveBundledSkillsRoot();
    if (!root) {
        return [];
    }

    try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        const skills = await Promise.all(
            entries
                .filter((entry) => entry.isDirectory())
                .map(async (entry) => {
                    const skillFile = path.join(root, entry.name, 'SKILL.md');
                    try {
                        await fs.access(skillFile);
                        return entry.name;
                    } catch {
                        return null;
                    }
                }),
        );

        return skills
            .filter((name): name is string => !!name)
            .sort((a, b) => a.localeCompare(b));
    } catch {
        return [];
    }
}

export async function readBundledSkills(
    skillNames: string[],
): Promise<BundledSkillDocument[]> {
    const root = await resolveBundledSkillsRoot();
    if (!root) {
        throw new Error('Bundled skills directory not found.');
    }

    const documents = await Promise.all(
        skillNames.map(async (rawName) => {
            const name = assertValidSkillName(rawName);
            const skillDir = path.join(root, name);
            const filePath = path.join(skillDir, 'SKILL.md');
            const content = await fs.readFile(filePath, 'utf8');
            const files = await readBundledSkillFiles(skillDir);
            return { name, content, files };
        }),
    );

    return documents;
}

export async function readBundledSkill(name: string): Promise<string> {
    const [skill] = await readBundledSkills([name]);
    return skill.content;
}

async function readBundledSkillFiles(
    skillDir: string,
): Promise<{ relativePath: string; content: string }[]> {
    const queue: string[] = ['.'];
    const files: { relativePath: string; content: string }[] = [];

    while (queue.length > 0) {
        const currentRelativeDir = queue.shift();
        if (!currentRelativeDir) {
            continue;
        }

        const absoluteDir = path.join(skillDir, currentRelativeDir);
        const entries = await fs.readdir(absoluteDir, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.name.startsWith('.')) {
                continue;
            }

            const entryRelativePath = path.join(currentRelativeDir, entry.name);
            if (entry.isDirectory()) {
                queue.push(entryRelativePath);
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            const normalizedRelativePath = path
                .normalize(entryRelativePath)
                .replace(/^\.\//, '');
            const absoluteFilePath = path.join(
                skillDir,
                normalizedRelativePath,
            );
            const fileContent = await fs.readFile(absoluteFilePath, 'utf8');
            files.push({
                relativePath: normalizedRelativePath,
                content: fileContent,
            });
        }
    }

    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return files;
}
