#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { renderAliasSkillContent, SKILL_ALIASES } from './skills-aliases.mjs';
import { assertSafeChildName } from './skills-utils.mjs';

async function syncAlias(canonicalDir, aliasDir) {
    const canonicalFile = path.join(canonicalDir, 'SKILL.md');
    const aliasFile = path.join(aliasDir, 'SKILL.md');
    const canonicalContent = await fs.readFile(canonicalFile, 'utf8');
    const expectedAliasContent = renderAliasSkillContent(
        canonicalContent,
        path.basename(aliasDir),
    );

    let existingContent = null;
    try {
        existingContent = await fs.readFile(aliasFile, 'utf8');
    } catch {
        // Alias file does not exist yet.
    }

    if (existingContent === expectedAliasContent) {
        return 'unchanged';
    }

    await fs.mkdir(aliasDir, { recursive: true });
    await fs.writeFile(aliasFile, expectedAliasContent, 'utf8');
    return existingContent === null ? 'created' : 'updated';
}

async function main() {
    const cwd = process.cwd();
    const skillsRoot = path.join(cwd, 'skills');
    let created = 0;
    let updated = 0;
    let unchanged = 0;

    for (const entry of SKILL_ALIASES) {
        const canonicalDir = path.join(
            skillsRoot,
            assertSafeChildName(entry.canonical, 'canonical skill name'),
        );
        const aliasDir = path.join(
            skillsRoot,
            assertSafeChildName(entry.alias, 'alias skill name'),
        );
        const status = await syncAlias(canonicalDir, aliasDir);
        if (status === 'created') {
            created += 1;
        } else if (status === 'updated') {
            updated += 1;
        } else {
            unchanged += 1;
        }
    }

    process.stdout.write(
        `Skill aliases synced: ${created} created, ${updated} updated, ${unchanged} unchanged.\n`,
    );
}

main().catch((error) => {
    process.stderr.write(`Failed to sync skill aliases: ${error.message}\n`);
    process.exitCode = 1;
});
