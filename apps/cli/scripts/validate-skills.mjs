#!/usr/bin/env node

import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { discoverSkillDirs, exists, readSkill } from './skills-utils.mjs';
import { renderAliasSkillContent, SKILL_ALIASES } from './skills-aliases.mjs';

const errors = [];
const warnings = [];
const cwd = process.cwd();
const defaultRoot = 'skills';

const allowedFrontmatterFields = new Set([
    'name',
    'description',
    'triggers',
    'allowed-tools',
    'license',
    'compatibility',
    'metadata',
]);

async function collectFilesRecursively(dirPath) {
    const collected = [];
    const stack = [dirPath];

    while (stack.length > 0) {
        const current = stack.pop();
        const entries = await fs.readdir(current, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
            } else if (entry.isFile()) {
                collected.push(fullPath);
            }
        }
    }

    return collected;
}

function addError(message) {
    errors.push(message);
}

function addWarning(message) {
    warnings.push(message);
}

function normalizeResourcePath(rawPath) {
    if (!rawPath) {
        return null;
    }
    if (/^[a-z]+:\/\//i.test(rawPath)) {
        return null;
    }

    const pathWithoutQueryOrHash = rawPath.split(/[?#]/, 1)[0];
    if (!pathWithoutQueryOrHash) {
        return null;
    }

    const cleaned = pathWithoutQueryOrHash.replace(/\\/g, '/').trim();
    if (
        !cleaned.startsWith('scripts/') &&
        !cleaned.startsWith('references/') &&
        !cleaned.startsWith('assets/')
    ) {
        return null;
    }
    if (cleaned.includes('<') || cleaned.includes('>')) {
        return null;
    }

    return cleaned;
}

function extractReferencedResourcePaths(body) {
    const refs = new Set();
    const markdownLinkRegex = /\[[^\]]*]\(([^)]+)\)/g;
    const inlineCodeRegex = /`((?:scripts|references|assets)\/[^`\s)]+)`/g;

    let match;
    while ((match = markdownLinkRegex.exec(body)) !== null) {
        const normalized = normalizeResourcePath(match[1].trim());
        if (normalized) {
            refs.add(normalized);
        }
    }

    while ((match = inlineCodeRegex.exec(body)) !== null) {
        const normalized = normalizeResourcePath(match[1].trim());
        if (normalized) {
            refs.add(normalized);
        }
    }

    return [...refs];
}

function validateFrontmatter(skillDirName, frontmatter) {
    if (
        !frontmatter ||
        typeof frontmatter !== 'object' ||
        Array.isArray(frontmatter)
    ) {
        addError(`[${skillDirName}] Frontmatter must be a YAML object.`);
        return { name: null, description: null };
    }

    const unknownKeys = Object.keys(frontmatter).filter(
        (key) => !allowedFrontmatterFields.has(key),
    );
    if (unknownKeys.length > 0) {
        addWarning(
            `[${skillDirName}] Unknown frontmatter fields: ${unknownKeys.join(', ')}.`,
        );
    }

    let name = null;
    if (
        typeof frontmatter.name !== 'string' ||
        frontmatter.name.trim().length === 0
    ) {
        addError(
            `[${skillDirName}] Frontmatter must include non-empty string "name".`,
        );
    } else {
        name = frontmatter.name.trim();
        if (name.length > 64) {
            addError(
                `[${skillDirName}] Frontmatter name must be at most 64 characters.`,
            );
        }
        if (!/^[a-z0-9-]+$/.test(name)) {
            addError(
                `[${skillDirName}] Frontmatter name "${name}" must match /^[a-z0-9-]+$/.`,
            );
        }
        if (name.startsWith('-') || name.endsWith('-')) {
            addError(
                `[${skillDirName}] Frontmatter name "${name}" cannot start or end with "-".`,
            );
        }
        if (name.includes('--')) {
            addError(
                `[${skillDirName}] Frontmatter name "${name}" cannot contain consecutive hyphens.`,
            );
        }
        if (name !== skillDirName) {
            addError(
                `[${skillDirName}] Frontmatter name "${name}" must match folder name "${skillDirName}".`,
            );
        }
    }

    let description = null;
    if (
        typeof frontmatter.description !== 'string' ||
        frontmatter.description.trim().length === 0
    ) {
        addError(
            `[${skillDirName}] Frontmatter must include non-empty string "description".`,
        );
    } else {
        description = frontmatter.description.trim();
        if (description.length > 1024) {
            addError(
                `[${skillDirName}] Description must be at most 1024 characters.`,
            );
        }
        if (!description.includes('Use when')) {
            addWarning(
                `[${skillDirName}] Description should include "Use when" to improve skill triggering consistency.`,
            );
        }
    }

    if (frontmatter.triggers !== undefined) {
        if (!Array.isArray(frontmatter.triggers)) {
            addError(
                `[${skillDirName}] "triggers" must be an array of strings when provided.`,
            );
        } else {
            for (const trigger of frontmatter.triggers) {
                if (
                    typeof trigger !== 'string' ||
                    trigger.trim().length === 0
                ) {
                    addError(
                        `[${skillDirName}] Every trigger must be a non-empty string.`,
                    );
                    break;
                }
            }
        }
    }

    if (frontmatter['allowed-tools'] !== undefined) {
        if (
            typeof frontmatter['allowed-tools'] !== 'string' ||
            frontmatter['allowed-tools'].trim().length === 0
        ) {
            addError(
                `[${skillDirName}] "allowed-tools" must be a non-empty string when provided.`,
            );
        }
    }

    if (frontmatter.compatibility !== undefined) {
        if (
            typeof frontmatter.compatibility !== 'string' ||
            frontmatter.compatibility.trim().length === 0
        ) {
            addError(
                `[${skillDirName}] "compatibility" must be a non-empty string when provided.`,
            );
        } else if (frontmatter.compatibility.length > 500) {
            addError(
                `[${skillDirName}] "compatibility" must be at most 500 characters.`,
            );
        }
    }

    if (frontmatter.license !== undefined) {
        if (
            typeof frontmatter.license !== 'string' ||
            frontmatter.license.trim().length === 0
        ) {
            addError(
                `[${skillDirName}] "license" must be a non-empty string when provided.`,
            );
        }
    }

    if (frontmatter.metadata !== undefined) {
        if (
            !frontmatter.metadata ||
            typeof frontmatter.metadata !== 'object' ||
            Array.isArray(frontmatter.metadata)
        ) {
            addError(
                `[${skillDirName}] "metadata" must be an object of string values when provided.`,
            );
        } else {
            for (const [key, value] of Object.entries(frontmatter.metadata)) {
                if (typeof key !== 'string' || key.trim().length === 0) {
                    addError(
                        `[${skillDirName}] "metadata" keys must be non-empty strings.`,
                    );
                    break;
                }
                if (typeof value !== 'string') {
                    addError(
                        `[${skillDirName}] "metadata.${key}" must be a string.`,
                    );
                    break;
                }
            }
        }
    }

    return { name, description };
}

async function validateSkillDirectory(skillDir) {
    const skillDirName = path.basename(skillDir);
    const parsedSkill = await readSkill(skillDir);
    if (parsedSkill.error) {
        addError(`[${skillDirName}] ${parsedSkill.error}`);
        return;
    }

    const { frontmatter, body } = parsedSkill;
    const validationResult = validateFrontmatter(skillDirName, frontmatter);

    if (!body || body.trim().length === 0) {
        addError(`[${skillDirName}] SKILL.md body is empty.`);
    }

    const resourceRefs = extractReferencedResourcePaths(body);
    for (const refPath of resourceRefs) {
        const absolutePath = path.resolve(skillDir, refPath);
        const relativeToSkill = path.relative(skillDir, absolutePath);
        if (relativeToSkill.startsWith('..')) {
            addError(
                `[${skillDirName}] Referenced resource escapes skill folder: ${refPath}`,
            );
            continue;
        }
        if (!(await exists(absolutePath))) {
            addError(
                `[${skillDirName}] Referenced resource does not exist: ${refPath}`,
            );
        }
    }

    const scriptsDir = path.join(skillDir, 'scripts');
    if (await exists(scriptsDir)) {
        const files = await collectFilesRecursively(scriptsDir);
        for (const filePath of files) {
            if (filePath.endsWith('.sh')) {
                try {
                    await fs.access(filePath, constants.X_OK);
                } catch {
                    addError(
                        `[${skillDirName}] Shell script is not executable: ${path.relative(cwd, filePath)}`,
                    );
                }
            }
        }
    }

    return validationResult;
}

async function validateSkillAliases(skillsRoot) {
    for (const entry of SKILL_ALIASES) {
        const canonicalFile = path.join(
            skillsRoot,
            entry.canonical,
            'SKILL.md',
        );
        const aliasFile = path.join(skillsRoot, entry.alias, 'SKILL.md');

        if (!(await exists(canonicalFile))) {
            addError(
                `[${entry.alias}] Missing canonical skill source: ${path.relative(cwd, canonicalFile)}.`,
            );
            continue;
        }
        if (!(await exists(aliasFile))) {
            addError(
                `[${entry.alias}] Missing alias skill file: ${path.relative(cwd, aliasFile)}.`,
            );
            continue;
        }

        const canonicalContent = await fs.readFile(canonicalFile, 'utf8');
        const aliasContent = await fs.readFile(aliasFile, 'utf8');
        const expectedAliasContent = renderAliasSkillContent(
            canonicalContent,
            entry.alias,
        );
        if (aliasContent !== expectedAliasContent) {
            addError(
                `[${entry.alias}] Alias content is out of sync with canonical "${entry.canonical}". Run: node scripts/sync-skills-aliases.mjs`,
            );
        }
    }
}

async function main() {
    const inputPaths = process.argv.slice(2);
    const roots = inputPaths.length > 0 ? inputPaths : [defaultRoot];
    const skillDirs = await discoverSkillDirs(roots);

    if (skillDirs.length === 0) {
        addWarning(`No skills found in: ${roots.join(', ')}`);
    }

    const skillNames = new Map();
    for (const skillDir of skillDirs) {
        const validationResult = await validateSkillDirectory(skillDir);
        if (validationResult?.name) {
            if (skillNames.has(validationResult.name)) {
                addError(
                    `Duplicate skill name "${validationResult.name}" in folders "${skillNames.get(
                        validationResult.name,
                    )}" and "${path.basename(skillDir)}".`,
                );
            } else {
                skillNames.set(validationResult.name, path.basename(skillDir));
            }
        }
    }

    const defaultSkillsRoot = path.resolve(defaultRoot);
    const resolvedRoots = roots.map((root) => path.resolve(root));
    if (resolvedRoots.includes(defaultSkillsRoot)) {
        await validateSkillAliases(defaultSkillsRoot);
    }

    if (errors.length > 0) {
        console.error('Skill validation failed:');
        for (const error of errors) {
            console.error(`- ${error}`);
        }
    }

    if (warnings.length > 0) {
        console.warn('Skill validation warnings:');
        for (const warning of warnings) {
            console.warn(`- ${warning}`);
        }
    }

    if (errors.length > 0) {
        process.exit(1);
    }

    console.log(`Skill validation passed (${warnings.length} warning(s)).`);
}

main().catch((error) => {
    console.error(`Skill validation crashed: ${error.message}`);
    process.exit(1);
});
