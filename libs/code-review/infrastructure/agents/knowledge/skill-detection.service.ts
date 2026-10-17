import { createLogger } from '@libs/core/log/logger';
import { Injectable } from '@nestjs/common';

import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

import {
    CodeManagementBaseBranchReader,
    type KnowledgeCodeManagementPort,
} from './base-branch-reader';
import { locateSkill } from './knowledge-resolver';
import { parseSkillMarkdown } from './skill-validator';

/**
 * Finds the skills a repository already has on its default branch, so the
 * Skills & docs screen can offer them for linking instead of asking for paths.
 */

export const SKILL_DETECTION_PATTERNS = [
    '.claude/skills/*/SKILL.md',
    '.claude/agents/*.md',
    '.agents/skills/*/SKILL.md',
    '.github/skills/*/SKILL.md',
] as const;

/** Enough for any real repository; bounds the provider reads per request. */
export const MAX_DETECTED_SKILLS = 50;

export interface DetectedSkill {
    /** Value to store in `KnowledgeItem.path`: the skill folder, or the file for a single-file skill. */
    path: string;
    /** File holding the frontmatter. */
    file: string;
    /** Which convention the skill was found under (e.g. `.claude/skills`). */
    source: string;
    valid: boolean;
    name?: string;
    description?: string;
    errors?: string[];
}

export const REPOSITORY_SKILL_DETECTION_SERVICE_TOKEN = Symbol(
    'RepositorySkillDetectionService',
);

/** Candidate skill files among repository paths, in a stable order. */
export function matchSkillCandidates(paths: string[]): string[] {
    return [...new Set(paths)]
        .filter((p) => isFileMatchingGlob(p, [...SKILL_DETECTION_PATTERNS]))
        .sort()
        .slice(0, MAX_DETECTED_SKILLS);
}

function sourceOf(file: string): string {
    return SKILL_DETECTION_PATTERNS.find((p) =>
        isFileMatchingGlob(file, [p]),
    )!.split('/*')[0];
}

@Injectable()
export class RepositorySkillDetectionService {
    private readonly logger = createLogger(
        RepositorySkillDetectionService.name,
    );

    constructor(
        private readonly codeManagementService: CodeManagementService,
    ) {}

    async detect(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        /** Defaults to the repository's default branch. */
        branch?: string;
    }): Promise<DetectedSkill[]> {
        const port = this
            .codeManagementService as unknown as KnowledgeCodeManagementPort;
        try {
            const branch =
                params.branch ??
                (await this.codeManagementService.getDefaultBranch({
                    organizationAndTeamData: params.organizationAndTeamData,
                    repository: params.repository,
                }));
            if (!branch) return [];

            const files = await port.getRepositoryAllFiles({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
                filters: {
                    branch,
                    filePatterns: [...SKILL_DETECTION_PATTERNS],
                },
            });
            const reader = new CodeManagementBaseBranchReader(port, {
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
                baseBranch: branch,
            });

            return await Promise.all(
                matchSkillCandidates((files ?? []).map((f) => f.path)).map(
                    (file) => detectOne(reader, file),
                ),
            );
        } catch (error) {
            this.logger.warn({
                message: 'Failed to detect repository skills',
                context: RepositorySkillDetectionService.name,
                error,
                metadata: {
                    organizationAndTeamData: params.organizationAndTeamData,
                    repositoryId: params.repository?.id,
                },
            });
            return [];
        }
    }
}

export async function detectOne(
    reader: Pick<CodeManagementBaseBranchReader, 'readFile'>,
    file: string,
): Promise<DetectedSkill> {
    const location = locateSkill(file)!;
    const path = location.folder ?? location.skillFile;
    const base = { path, file, source: sourceOf(file) };

    const read = await reader.readFile(file);
    if (read.status !== 'ok') {
        return {
            ...base,
            valid: false,
            errors: [
                read.status === 'missing' ? 'file not found' : read.reason,
            ],
        };
    }
    const parsed = parseSkillMarkdown(read.content, {
        expectedName: location.expectedName,
    });
    return parsed.ok
        ? {
              ...base,
              valid: true,
              name: parsed.skill.name,
              description: parsed.skill.description,
          }
        : { ...base, valid: false, errors: parsed.errors };
}
