import { describe, expect, it } from 'vitest';
import { buildSkillSyncTargets } from '../skills-sync-targets.js';

describe('buildSkillSyncTargets', () => {
    it('builds project and user targets from the shared definitions', () => {
        const targets = buildSkillSyncTargets('/repo/workspace', '/users/demo');

        expect(targets).toContainEqual({
            label: 'Codex project skills',
            type: 'skill',
            activationPath: '/repo/workspace/.codex',
            baseDir: '/repo/workspace/.codex/skills',
        });

        expect(targets).toContainEqual({
            label: 'Claude config commands',
            type: 'command',
            activationPath: '/users/demo/.config/claude',
            baseDir: '/users/demo/.config/claude/commands',
        });

        expect(targets).toContainEqual({
            label: 'Agents user skills',
            type: 'skill',
            activationPath: '/users/demo/.agents',
            baseDir: '/users/demo/.agents/skills',
        });

        expect(targets).toContainEqual({
            label: 'Agents user skills (legacy config path)',
            type: 'skill',
            activationPath: '/users/demo/.config/agents',
            baseDir: '/users/demo/.config/agents/skills',
        });

        expect(targets).toContainEqual({
            label: 'Gemini project skills',
            type: 'skill',
            activationPath: '/repo/workspace/.gemini',
            baseDir: '/repo/workspace/.gemini/skills',
        });

        expect(targets).toContainEqual({
            label: 'Kiro user skills',
            type: 'skill',
            activationPath: '/users/demo/.kiro',
            baseDir: '/users/demo/.kiro/skills',
        });
    });
});
