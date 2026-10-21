import * as yaml from 'js-yaml';

import {
    estimateTokens,
    tokensToChars,
} from '@libs/code-review/infrastructure/adapters/services/utils/token-estimator';

/**
 * SKILL.md validation, following the Agent Skills format (agentskills.io):
 * YAML frontmatter with `name` and `description`, then a Markdown body.
 *
 * - `name`: 1-64 chars, lowercase letters, digits and single hyphens, no
 *   leading or trailing hyphen. When it differs from a valid folder name the
 *   folder name is used and a note says so.
 * - `description`: 1-1024 chars, required.
 * - body: kept under 500 lines and ~5k tokens; longer bodies are cut and
 *   flagged so the review says it read a partial skill. The rest is read in
 *   pages of the same size with `readSkillFile` (`SKILL.md`, `offset`).
 * - `allowed-tools` is ignored: a skill never widens what a reviewer may run.
 * - `compatibility` is surfaced as a note, since the reviewer may lack what
 *   the skill expects.
 */

export const SKILL_LIMITS = {
    nameMaxLength: 64,
    descriptionMaxLength: 1024,
    bodyMaxLines: 500,
    bodyMaxTokens: 5000,
} as const;

const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const SKILL_BODY_TRUNCATED_MARKER =
    '[... skill truncated: only the first part of SKILL.md was loaded ...]';

export interface ParsedSkill {
    name: string;
    description: string;
    body: string;
    bodyTruncated: boolean;
    /** Body line the next page starts at, when the body was cut. */
    bodyNextOffset?: number;
    compatibility?: string;
}

export type SkillParseResult =
    | { ok: true; skill: ParsedSkill; notes: string[]; errors: [] }
    | { ok: false; errors: string[] };

const FRONTMATTER = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/;

/** The body of a SKILL.md, as the skill shows it; null without frontmatter. */
export function skillBodyOf(markdown: string): string | null {
    const match = FRONTMATTER.exec(normalizeSkillText(markdown));
    return match ? match[2].trim() : null;
}

function normalizeSkillText(markdown: string): string {
    return (markdown ?? '').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
}

/**
 * One page of a text, from line `offset` (0-based), within a line and a
 * token budget. `nextOffset` is where the next page starts when text is
 * left; a line cut by the token budget starts the next page again.
 */
export function pageText(
    text: string,
    offset: number,
    limits: { maxLines: number; maxTokens: number },
): { content: string; nextOffset?: number; totalLines: number } {
    const lines = text.split('\n');
    const start = Math.max(0, Math.min(Math.floor(offset) || 0, lines.length));
    const window = lines.slice(start, start + limits.maxLines);
    let content = window.join('\n');
    let shownLines = window.length;
    if (estimateTokens(content) > limits.maxTokens) {
        content = content.slice(0, tokensToChars(limits.maxTokens));
        const complete = content.split('\n').length - 1;
        // A single line longer than the budget is skipped past, so paging
        // always moves forward.
        shownLines = Math.max(1, complete);
    }
    const next = start + shownLines;
    return {
        content,
        totalLines: lines.length,
        ...(next < lines.length ? { nextOffset: next } : {}),
    };
}

export function parseSkillMarkdown(
    markdown: string,
    options: { expectedName?: string } = {},
): SkillParseResult {
    const text = normalizeSkillText(markdown);
    const match = FRONTMATTER.exec(text);
    if (!match) {
        return {
            ok: false,
            errors: ['SKILL.md must start with a YAML frontmatter block (---)'],
        };
    }

    let frontmatter: unknown;
    try {
        frontmatter = yaml.load(match[1]);
    } catch (error) {
        return {
            ok: false,
            errors: [`frontmatter is not valid YAML: ${firstLine(error)}`],
        };
    }
    if (!frontmatter || typeof frontmatter !== 'object') {
        return { ok: false, errors: ['frontmatter must be a YAML mapping'] };
    }

    const fields = frontmatter as Record<string, unknown>;
    const errors: string[] = [];

    const name = typeof fields.name === 'string' ? fields.name : '';
    if (!name) {
        errors.push('name is required');
    } else if (name.length > SKILL_LIMITS.nameMaxLength) {
        errors.push(
            `name must be at most ${SKILL_LIMITS.nameMaxLength} characters`,
        );
    } else if (!SKILL_NAME_PATTERN.test(name)) {
        errors.push(
            'name must use lowercase letters, digits and single hyphens, without a leading or trailing hyphen',
        );
    } else if (
        options.expectedName &&
        name !== options.expectedName &&
        !SKILL_NAME_PATTERN.test(options.expectedName)
    ) {
        errors.push(
            `name "${name}" must match its folder name "${options.expectedName}"`,
        );
    }
    // A name that differs from a valid folder name is read under the folder
    // name: the folder is what the agent config points at.
    const renamedFrom =
        name && options.expectedName && name !== options.expectedName
            ? name
            : undefined;

    const description =
        typeof fields.description === 'string' ? fields.description.trim() : '';
    if (!description) {
        errors.push('description is required');
    } else if (description.length > SKILL_LIMITS.descriptionMaxLength) {
        errors.push(
            `description must be at most ${SKILL_LIMITS.descriptionMaxLength} characters`,
        );
    }

    if (errors.length) return { ok: false, errors };

    const notes: string[] = [];
    if (renamedFrom) {
        notes.push(
            `name "${renamedFrom}" differs from its folder "${options.expectedName}"; using the folder name`,
        );
    }
    const { body, truncated, nextOffset } = capBody(match[2].trim());
    if (truncated) {
        notes.push(
            `SKILL.md body truncated to ${SKILL_LIMITS.bodyMaxLines} lines / ~${SKILL_LIMITS.bodyMaxTokens} tokens`,
        );
    }

    const compatibility =
        typeof fields.compatibility === 'string' && fields.compatibility.trim()
            ? fields.compatibility.trim()
            : undefined;
    if (compatibility) {
        notes.push(`compatibility: ${compatibility}`);
    }

    return {
        ok: true,
        skill: {
            name: renamedFrom ? options.expectedName : name,
            description,
            body,
            bodyTruncated: truncated,
            ...(nextOffset !== undefined ? { bodyNextOffset: nextOffset } : {}),
            ...(compatibility ? { compatibility } : {}),
        },
        notes,
        errors: [],
    };
}

function capBody(body: string): {
    body: string;
    truncated: boolean;
    nextOffset?: number;
} {
    const page = pageText(body, 0, {
        maxLines: SKILL_LIMITS.bodyMaxLines,
        maxTokens: SKILL_LIMITS.bodyMaxTokens,
    });
    return page.nextOffset !== undefined
        ? {
              body: `${page.content}\n\n${SKILL_BODY_TRUNCATED_MARKER}`,
              truncated: true,
              nextOffset: page.nextOffset,
          }
        : { body: page.content, truncated: false };
}

function firstLine(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.split('\n')[0];
}
