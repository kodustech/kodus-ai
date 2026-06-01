#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

export function assertSafeChildName(value, label = 'path') {
    const trimmed = String(value ?? '').trim();
    if (
        !trimmed ||
        trimmed === '.' ||
        trimmed === '..' ||
        trimmed.includes('/') ||
        trimmed.includes('\\') ||
        path.basename(trimmed) !== trimmed
    ) {
        throw new Error(`Invalid ${label}: ${value}`);
    }

    return trimmed;
}

export async function exists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

export function parseFrontmatter(content) {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
    if (!match) {
        return { error: 'Missing YAML frontmatter delimited by ---.' };
    }

    const yamlBlock = match[1];
    const body = content.slice(match[0].length);
    return { yamlBlock, body };
}

async function collectNestedSkillDirs(rootDir) {
    const collected = [];
    const stack = [rootDir];

    while (stack.length > 0) {
        const currentDir = stack.pop();
        let entries;
        try {
            entries = await fs.readdir(currentDir, { withFileTypes: true });
        } catch {
            continue;
        }

        let hasSkill = false;
        for (const entry of entries) {
            if (entry.isFile() && entry.name === 'SKILL.md') {
                hasSkill = true;
                break;
            }
        }

        if (hasSkill) {
            collected.push(currentDir);
            continue;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            if (entry.name.startsWith('.')) {
                continue;
            }
            stack.push(path.join(currentDir, entry.name));
        }
    }

    return collected;
}

export async function discoverSkillDirs(inputPaths = ['skills']) {
    const discovered = [];

    for (const inputPath of inputPaths) {
        const resolvedPath = path.resolve(inputPath);
        let stats;
        try {
            stats = await fs.stat(resolvedPath);
        } catch {
            continue;
        }

        if (stats.isFile()) {
            if (path.basename(resolvedPath) === 'SKILL.md') {
                discovered.push(path.dirname(resolvedPath));
            }
            continue;
        }

        if (!stats.isDirectory()) {
            continue;
        }

        if (await exists(path.join(resolvedPath, 'SKILL.md'))) {
            discovered.push(resolvedPath);
            continue;
        }

        const nested = await collectNestedSkillDirs(resolvedPath);
        discovered.push(...nested);
    }

    return [...new Set(discovered)].sort((a, b) => a.localeCompare(b));
}

export async function readSkill(skillDir) {
    const skillFilePath = path.join(skillDir, 'SKILL.md');
    const content = await fs.readFile(skillFilePath, 'utf8');
    const parsed = parseFrontmatter(content);
    if (parsed.error) {
        return { error: parsed.error, skillDir, skillFilePath };
    }

    let frontmatter;
    try {
        frontmatter = YAML.parse(parsed.yamlBlock);
    } catch (error) {
        return {
            error: `Invalid YAML frontmatter: ${error.message}`,
            skillDir,
            skillFilePath,
        };
    }

    return {
        skillDir,
        skillFilePath,
        frontmatter,
        body: parsed.body ?? '',
        content,
    };
}
