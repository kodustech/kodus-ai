import path from 'node:path';
import type { SkillSyncTarget } from './skills-sync.js';

type SkillSyncTargetDefinition = {
    label: string;
    scope: 'project' | 'user';
    type: SkillSyncTarget['type'];
    activationSegments: string[];
    baseSegments: string[];
};

const SKILL_SYNC_TARGET_DEFINITIONS: SkillSyncTargetDefinition[] = [
    {
        label: 'Codex project skills',
        scope: 'project',
        type: 'skill',
        activationSegments: ['.codex'],
        baseSegments: ['.codex', 'skills'],
    },
    {
        label: 'Codex user skills',
        scope: 'user',
        type: 'skill',
        activationSegments: ['.codex'],
        baseSegments: ['.codex', 'skills'],
    },
    {
        label: 'Claude project commands',
        scope: 'project',
        type: 'command',
        activationSegments: ['.claude'],
        baseSegments: ['.claude', 'commands'],
    },
    {
        label: 'Claude user commands',
        scope: 'user',
        type: 'command',
        activationSegments: ['.claude'],
        baseSegments: ['.claude', 'commands'],
    },
    {
        label: 'Claude config commands',
        scope: 'user',
        type: 'command',
        activationSegments: ['.config', 'claude'],
        baseSegments: ['.config', 'claude', 'commands'],
    },
    {
        label: 'Cursor project commands',
        scope: 'project',
        type: 'command',
        activationSegments: ['.cursor'],
        baseSegments: ['.cursor', 'commands'],
    },
    {
        label: 'Cursor user commands',
        scope: 'user',
        type: 'command',
        activationSegments: ['.cursor'],
        baseSegments: ['.cursor', 'commands'],
    },
    {
        label: 'Agents project skills',
        scope: 'project',
        type: 'skill',
        activationSegments: ['.agents'],
        baseSegments: ['.agents', 'skills'],
    },
    {
        label: 'Agents user skills',
        scope: 'user',
        type: 'skill',
        activationSegments: ['.agents'],
        baseSegments: ['.agents', 'skills'],
    },
    {
        label: 'Agents user skills (legacy config path)',
        scope: 'user',
        type: 'skill',
        activationSegments: ['.config', 'agents'],
        baseSegments: ['.config', 'agents', 'skills'],
    },
    {
        label: 'OpenCode project skills',
        scope: 'project',
        type: 'skill',
        activationSegments: ['.opencode'],
        baseSegments: ['.opencode', 'skill'],
    },
    {
        label: 'OpenCode user commands',
        scope: 'user',
        type: 'command',
        activationSegments: ['.config', 'opencode'],
        baseSegments: ['.config', 'opencode', 'command'],
    },
    {
        label: 'AiderDesk project commands',
        scope: 'project',
        type: 'command',
        activationSegments: ['.aider-desk'],
        baseSegments: ['.aider-desk', 'commands'],
    },
    {
        label: 'AiderDesk user commands',
        scope: 'user',
        type: 'command',
        activationSegments: ['.aider-desk'],
        baseSegments: ['.aider-desk', 'commands'],
    },
    {
        label: 'Kilo Code project skills',
        scope: 'project',
        type: 'skill',
        activationSegments: ['.kilocode'],
        baseSegments: ['.kilocode', 'skills'],
    },
    {
        label: 'Kilo Code user skills',
        scope: 'user',
        type: 'skill',
        activationSegments: ['.kilocode'],
        baseSegments: ['.kilocode', 'skills'],
    },
    {
        label: 'Roo Code project skills',
        scope: 'project',
        type: 'skill',
        activationSegments: ['.roo'],
        baseSegments: ['.roo', 'skills'],
    },
    {
        label: 'Roo Code user skills',
        scope: 'user',
        type: 'skill',
        activationSegments: ['.roo'],
        baseSegments: ['.roo', 'skills'],
    },
    {
        label: 'Goose project skills',
        scope: 'project',
        type: 'skill',
        activationSegments: ['.goose'],
        baseSegments: ['.goose', 'skills'],
    },
    {
        label: 'Goose user skills',
        scope: 'user',
        type: 'skill',
        activationSegments: ['.config', 'goose'],
        baseSegments: ['.config', 'goose', 'skills'],
    },
    {
        label: 'Antigravity project skills',
        scope: 'project',
        type: 'skill',
        activationSegments: ['.agent'],
        baseSegments: ['.agent', 'skills'],
    },
    {
        label: 'Antigravity user skills',
        scope: 'user',
        type: 'skill',
        activationSegments: ['.gemini', 'antigravity'],
        baseSegments: ['.gemini', 'antigravity', 'skills'],
    },
    {
        label: 'Droid project skills',
        scope: 'project',
        type: 'skill',
        activationSegments: ['.factory'],
        baseSegments: ['.factory', 'skills'],
    },
    {
        label: 'Droid user skills',
        scope: 'user',
        type: 'skill',
        activationSegments: ['.factory'],
        baseSegments: ['.factory', 'skills'],
    },
    {
        label: 'Windsurf project skills',
        scope: 'project',
        type: 'skill',
        activationSegments: ['.windsurf'],
        baseSegments: ['.windsurf', 'skills'],
    },
    {
        label: 'Windsurf user skills',
        scope: 'user',
        type: 'skill',
        activationSegments: ['.codeium', 'windsurf'],
        baseSegments: ['.codeium', 'windsurf', 'skills'],
    },
    {
        label: 'Gemini project skills',
        scope: 'project',
        type: 'skill',
        activationSegments: ['.gemini'],
        baseSegments: ['.gemini', 'skills'],
    },
    {
        label: 'Kiro project skills',
        scope: 'project',
        type: 'skill',
        activationSegments: ['.kiro'],
        baseSegments: ['.kiro', 'skills'],
    },
    {
        label: 'Kiro user skills',
        scope: 'user',
        type: 'skill',
        activationSegments: ['.kiro'],
        baseSegments: ['.kiro', 'skills'],
    },
];

export function buildSkillSyncTargets(
    cwd: string,
    homeDir: string,
): SkillSyncTarget[] {
    return SKILL_SYNC_TARGET_DEFINITIONS.map((definition) => {
        const root = definition.scope === 'project' ? cwd : homeDir;

        return {
            label: definition.label,
            type: definition.type,
            activationPath: path.join(root, ...definition.activationSegments),
            baseDir: path.join(root, ...definition.baseSegments),
        };
    });
}
