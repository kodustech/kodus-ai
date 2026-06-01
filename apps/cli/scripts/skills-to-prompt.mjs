#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { discoverSkillDirs, readSkill } from './skills-utils.mjs';

function escapeXml(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

function parseArgs(argv) {
    let format = 'xml';
    let includeLocation = true;
    const roots = [];

    for (const arg of argv) {
        if (arg === '--format=json') {
            format = 'json';
            continue;
        }
        if (arg === '--format=xml') {
            format = 'xml';
            continue;
        }
        if (arg === '--no-location') {
            includeLocation = false;
            continue;
        }
        roots.push(arg);
    }

    return {
        format,
        includeLocation,
        roots: roots.length > 0 ? roots : ['skills'],
    };
}

async function loadSkills(roots) {
    const skillDirs = await discoverSkillDirs(roots);
    const errors = [];
    const skills = [];

    for (const skillDir of skillDirs) {
        const parsedSkill = await readSkill(skillDir);
        const skillFolderName = path.basename(skillDir);
        if (parsedSkill.error) {
            errors.push(`[${skillFolderName}] ${parsedSkill.error}`);
            continue;
        }

        const name = parsedSkill.frontmatter?.name;
        const description = parsedSkill.frontmatter?.description;
        if (typeof name !== 'string' || name.trim().length === 0) {
            errors.push(
                `[${skillFolderName}] Missing non-empty "name" in frontmatter.`,
            );
            continue;
        }
        if (
            typeof description !== 'string' ||
            description.trim().length === 0
        ) {
            errors.push(
                `[${skillFolderName}] Missing non-empty "description" in frontmatter.`,
            );
            continue;
        }

        skills.push({
            name: name.trim(),
            description: description.trim(),
            location: parsedSkill.skillFilePath,
        });
    }

    skills.sort((a, b) => a.name.localeCompare(b.name));
    return { skills, errors };
}

function renderXml(skills, includeLocation) {
    const lines = ['<available_skills>'];
    for (const skill of skills) {
        lines.push('  <skill>');
        lines.push(`    <name>${escapeXml(skill.name)}</name>`);
        lines.push(
            `    <description>${escapeXml(skill.description)}</description>`,
        );
        if (includeLocation) {
            lines.push(`    <location>${escapeXml(skill.location)}</location>`);
        }
        lines.push('  </skill>');
    }
    lines.push('</available_skills>');
    return lines.join('\n');
}

async function main() {
    const { format, includeLocation, roots } = parseArgs(process.argv.slice(2));
    const { skills, errors } = await loadSkills(roots);

    if (errors.length > 0) {
        console.error('Failed to generate skills prompt metadata:');
        for (const error of errors) {
            console.error(`- ${error}`);
        }
        process.exit(1);
    }

    if (format === 'json') {
        const jsonPayload = skills.map((skill) =>
            includeLocation
                ? {
                      name: skill.name,
                      description: skill.description,
                      location: skill.location,
                  }
                : { name: skill.name, description: skill.description },
        );
        process.stdout.write(`${JSON.stringify(jsonPayload, null, 2)}\n`);
        return;
    }

    process.stdout.write(`${renderXml(skills, includeLocation)}\n`);
}

main().catch((error) => {
    console.error(
        `Failed to generate skills prompt metadata: ${error.message}`,
    );
    process.exit(1);
});
