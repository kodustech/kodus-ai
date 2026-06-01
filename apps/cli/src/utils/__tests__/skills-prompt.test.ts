import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIR, '../../..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'skills-to-prompt.mjs');

function readPromptJson(args: string[] = []) {
    return JSON.parse(
        execFileSync('node', [SCRIPT_PATH, '--format=json', ...args], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
        }),
    ) as Array<{ name: string; description: string }>;
}

describe('skills prompt metadata', () => {
    it('lists only canonical skill names', () => {
        const skills = readPromptJson();
        const names = skills.map((skill) => skill.name);

        expect(names).toContain('kodus-business-rules-validation');
        expect(names).toContain('kodus-centralized-config');
        expect(names).not.toContain('business-rules-validation');
    });
});
