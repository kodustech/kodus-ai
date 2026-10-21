import type {
    AgentTool,
    ToolResult,
} from '@libs/agent-harness/domain/contracts/tool.contract';
import { RunToolCache } from '@libs/code-review/infrastructure/agents/adapters/run-tool-cache';

import type { BaseBranchReader } from './base-branch-reader';
import { resolveInsideFolder } from './knowledge-path';
import { renderLoadedSkill } from './knowledge-prompt';
import type { ResolvedKnowledge, ResolvedSkill } from './knowledge-resolver';
import { pageText, SKILL_LIMITS, skillBodyOf } from './skill-validator';

/**
 * `loadSkill` and `readSkillFile` for one review target. Both serve only the
 * skills linked to that target, from the target branch. `readSkillFile` opens
 * a file only when it is in the skill folder's listing, which was taken from
 * the target branch and leaves out symlinks, so neither a `..` path nor a
 * symlink reaches anything outside the skill.
 *
 * A file read is kept for the review run (`cache`, keyed by ref, skill and
 * file), since the finder, the recall pass and the verifiers each open it
 * again. `loadSkill` is not cached: it renders the skill already resolved in
 * memory and reads nothing.
 */

export const LOAD_SKILL_TOOL = 'loadSkill';
export const READ_SKILL_FILE_TOOL = 'readSkillFile';

const MAX_SKILL_FILE_TOKENS = 5000;
/** A file longer than one page is read in pages of this size. */
const SKILL_FILE_PAGE = {
    maxLines: SKILL_LIMITS.bodyMaxLines,
    maxTokens: MAX_SKILL_FILE_TOKENS,
};

/** A skill the agent opened, or one of its files it read, that returned content. */
export interface SkillRead {
    skill: string;
    /** The file read from the skill folder; absent for loadSkill. */
    path?: string;
}

export function buildKnowledgeTools(
    knowledge: ResolvedKnowledge | undefined,
    reader: BaseBranchReader,
    cache: RunToolCache = new RunToolCache(),
    /** Told of each skill opened and file read that returned content. */
    onRead?: (read: SkillRead) => void,
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
            onRead?.({ skill: skill.name });
            return {
                output: renderLoadedSkill(skill, knowledge!.ref),
                meta: { skill: skill.name, truncated: skill.bodyTruncated },
            };
        },
    };

    const readSkillFile: AgentTool<{
        skill: string;
        path: string;
        offset?: number;
    }> = {
        name: READ_SKILL_FILE_TOOL,
        description:
            'Read a file that a loaded skill lists (for example references/x.md), relative to the skill folder. Scripts are returned as text and never run. A long file comes back in parts: pass the offset the output names to read the next part, and path "SKILL.md" with an offset to read past where loadSkill stopped.',
        inputSchema: {
            type: 'object',
            properties: {
                skill: { type: 'string', enum: names },
                path: {
                    type: 'string',
                    description: 'Path relative to the skill folder.',
                },
                offset: {
                    type: 'integer',
                    minimum: 0,
                    description:
                        'Line to start from, as named by a truncated output. Omit to read from the start.',
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
            const offset = Number.isInteger(input?.offset)
                ? Math.max(0, input.offset)
                : 0;
            const asked = (input?.path ?? '').replace(/^\.\//, '');
            if (asked === 'SKILL.md') {
                if (!offset) {
                    return {
                        output: `SKILL.md is the skill itself: call loadSkill with "${skill.name}" to read it. When loadSkill says SKILL.md continues, call readSkillFile with path "SKILL.md" and the offset it names.`,
                        isError: true,
                    };
                }
                const result = await cache.getOrRun(
                    ['skill-body', reader.ref, skill.name, String(offset)],
                    () => readSkillBodyPage(skill, offset),
                );
                if (!result.isError)
                    onRead?.({ skill: skill.name, path: 'SKILL.md' });
                return result;
            }
            if (!skill.folder) {
                return {
                    output: `Skill "${skill.name}" is a single file and has no other files.`,
                    isError: true,
                };
            }
            const full = resolveInsideFolder(skill.folder, input?.path ?? '');
            const relative = full?.slice(skill.folder.length + 1);
            if (relative === 'SKILL.md') {
                return {
                    output: `SKILL.md is the skill itself: call loadSkill with "${skill.name}" to read it.`,
                    isError: true,
                };
            }
            if (!full || !relative || !skill.files.includes(relative)) {
                return {
                    output: `"${input?.path}" is not a file of skill "${skill.name}". Files: ${skill.files.join(', ') || '(none)'}`,
                    isError: true,
                };
            }

            const result = await cache.getOrRun(
                [
                    'skill-file',
                    reader.ref,
                    skill.name,
                    relative,
                    ...(offset ? [String(offset)] : []),
                ],
                () => readSkillFileContent(skill.name, full, relative, offset),
            );
            if (!result.isError)
                onRead?.({ skill: skill.name, path: relative });
            return result;
        },
    };

    /** A page of SKILL.md's body past where loadSkill stopped. */
    async function readSkillBodyPage(
        skill: ResolvedSkill,
        offset: number,
    ): Promise<ToolResult> {
        const read = await reader.readFile(skill.path);
        if (read.status !== 'ok') {
            return {
                output:
                    read.status === 'missing'
                        ? `"SKILL.md" was not found on ${reader.ref}.`
                        : `"SKILL.md" cannot be read: ${read.reason}.`,
                isError: true,
            };
        }
        const body = skillBodyOf(read.content) ?? '';
        const page = pageText(body, offset, SKILL_FILE_PAGE);
        if (offset >= page.totalLines) {
            return {
                output: `SKILL.md of "${skill.name}" has ${page.totalLines} lines; offset ${offset} is past its end.`,
                isError: true,
            };
        }
        return {
            output: withContinuation(page, skill.name, 'SKILL.md', offset),
            meta: { skill: skill.name, path: 'SKILL.md', offset },
        };
    }

    async function readSkillFileContent(
        skillName: string,
        full: string,
        relative: string,
        offset = 0,
    ): Promise<ToolResult> {
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
        const page = pageText(read.content, offset, SKILL_FILE_PAGE);
        if (offset && offset >= page.totalLines) {
            return {
                output: `"${relative}" has ${page.totalLines} lines; offset ${offset} is past its end.`,
                isError: true,
            };
        }
        const content = withContinuation(page, skillName, relative, offset);
        return {
            output: relative.startsWith('scripts/')
                ? `(script shown as reference; it is never run)\n${content}`
                : content,
            meta: {
                skill: skillName,
                path: relative,
                ...(offset ? { offset } : {}),
            },
        };
    }

    return [loadSkill, readSkillFile];
}

/** A page, with how to read the next one when the file goes on. */
function withContinuation(
    page: { content: string; nextOffset?: number },
    skillName: string,
    path: string,
    offset: number,
): string {
    const from = offset ? `[from line ${offset}]\n` : '';
    if (page.nextOffset === undefined) return `${from}${page.content}`;
    return `${from}${page.content}\n\n[... truncated: continue with readSkillFile (skill "${skillName}", path "${path}", offset ${page.nextOffset}) ...]`;
}
