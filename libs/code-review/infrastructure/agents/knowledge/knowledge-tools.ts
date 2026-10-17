import type { AgentTool } from '@libs/agent-harness/domain/contracts/tool.contract';
import {
    estimateTokens,
    tokensToChars,
} from '@libs/code-review/infrastructure/adapters/services/utils/token-estimator';

import type { BaseBranchReader } from './base-branch-reader';
import { resolveInsideFolder } from './knowledge-path';
import { renderLoadedSkill } from './knowledge-prompt';
import type { ResolvedKnowledge } from './knowledge-resolver';

/**
 * `loadSkill` and `readSkillFile` for one review target. Both serve only the
 * skills linked to that target, from the target branch. `readSkillFile` opens
 * a file only when it is in the skill folder's listing, which was taken from
 * the target branch and leaves out symlinks, so neither a `..` path nor a
 * symlink reaches anything outside the skill.
 */

export const LOAD_SKILL_TOOL = 'loadSkill';
export const READ_SKILL_FILE_TOOL = 'readSkillFile';

const MAX_SKILL_FILE_TOKENS = 5000;

export function buildKnowledgeTools(
    knowledge: ResolvedKnowledge | undefined,
    reader: BaseBranchReader,
): AgentTool[] {
    const skills = knowledge?.skills ?? [];
    if (!skills.length) return [];
    const byName = new Map(skills.map((s) => [s.name, s]));
    const names = [...byName.keys()];

    const loadSkill: AgentTool<{ name: string }> = {
        name: LOAD_SKILL_TOOL,
        description:
            "Open one of the team's skills listed in the prompt and read how the team does that task.",
        inputSchema: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    enum: names,
                    description: 'Skill name from the catalog.',
                },
            },
            required: ['name'],
            additionalProperties: false,
        },
        async execute(input) {
            const skill = byName.get(input?.name);
            if (!skill) {
                return {
                    output: `Unknown skill "${input?.name}". Available: ${names.join(', ')}`,
                    isError: true,
                };
            }
            return {
                output: renderLoadedSkill(skill, knowledge!.ref),
                meta: { skill: skill.name, truncated: skill.bodyTruncated },
            };
        },
    };

    const readSkillFile: AgentTool<{ skill: string; path: string }> = {
        name: READ_SKILL_FILE_TOOL,
        description:
            'Read a file that a loaded skill lists (for example references/x.md), relative to the skill folder. Scripts are returned as text and never run.',
        inputSchema: {
            type: 'object',
            properties: {
                skill: { type: 'string', enum: names },
                path: {
                    type: 'string',
                    description: 'Path relative to the skill folder.',
                },
            },
            required: ['skill', 'path'],
            additionalProperties: false,
        },
        async execute(input) {
            const skill = byName.get(input?.skill);
            if (!skill) {
                return {
                    output: `Unknown skill "${input?.skill}".`,
                    isError: true,
                };
            }
            if (!skill.folder) {
                return {
                    output: `Skill "${skill.name}" is a single file and has no other files.`,
                    isError: true,
                };
            }
            const full = resolveInsideFolder(skill.folder, input?.path ?? '');
            const relative = full?.slice(skill.folder.length + 1);
            if (!full || !relative || !skill.files.includes(relative)) {
                return {
                    output: `"${input?.path}" is not a file of skill "${skill.name}". Files: ${skill.files.join(', ') || '(none)'}`,
                    isError: true,
                };
            }

            const read = await reader.readFile(full);
            if (read.status !== 'ok') {
                return {
                    output:
                        read.status === 'missing'
                            ? `"${relative}" was not found on ${reader.ref}.`
                            : `"${relative}" cannot be read: ${read.reason}.`,
                    isError: true,
                };
            }
            const content =
                estimateTokens(read.content) > MAX_SKILL_FILE_TOKENS
                    ? `${read.content.slice(0, tokensToChars(MAX_SKILL_FILE_TOKENS))}\n\n[... truncated ...]`
                    : read.content;
            return {
                output: relative.startsWith('scripts/')
                    ? `(script shown as reference; it is never run)\n${content}`
                    : content,
                meta: { skill: skill.name, path: relative },
            };
        },
    };

    return [loadSkill, readSkillFile];
}
