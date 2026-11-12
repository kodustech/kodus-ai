import { Inject, Injectable } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { REQUEST } from '@nestjs/core';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import {
    IIssuesService,
    ISSUES_SERVICE_TOKEN,
} from '@libs/issues/domain/contracts/issues.service.contract';
import {
    buildFixPrompt,
    FIX_PROMPT_MAX_ISSUES,
} from '@libs/issues/domain/fix-prompt';

export interface FixPromptResult {
    prompt: string;
    /** The issues the prompt carries, in the order asked. */
    included: string[];
    /** Asked for but not carried: unknown, another tenant's, or a repository the caller cannot read. */
    skipped: string[];
}

/**
 * The prompt a developer hands to their own coding agent to fix the issues
 * they picked (lib/issues/domain/fix-prompt.ts). Only issues of the caller's
 * organization, in repositories the caller may read, go into it: the prompt
 * carries how to exploit a vulnerability.
 */
@Injectable()
export class BuildFixPromptUseCase implements IUseCase {
    constructor(
        @Inject(ISSUES_SERVICE_TOKEN)
        private readonly issuesService: IIssuesService,
        @Inject(REQUEST)
        private readonly request: UserRequest,
        private readonly authorizationService: AuthorizationService,
    ) {}

    async execute(ids: string[]): Promise<FixPromptResult> {
        const wanted = [...new Set(ids)].slice(0, FIX_PROMPT_MAX_ISSUES);
        const organizationId = this.request.user.organization.uuid;
        const readable = await this.authorizationService.getRepositoryScope({
            user: this.request.user,
            action: Action.Read,
            resource: ResourceType.Issues,
        });

        const readableIds = readable === null ? null : new Set(readable);

        // A malformed id (a typo on the CLI) is no issue: skipped, like an
        // unknown one, instead of a database cast error.
        const issues = await Promise.all(
            wanted.map((id) =>
                isValidObjectId(id) ? this.issuesService.findById(id) : null,
            ),
        );
        const kept = issues.filter(
            (issue) =>
                !!issue?.repository?.id &&
                issue.organizationId === organizationId &&
                (readableIds === null || readableIds.has(issue.repository.id)),
        );
        const included = kept.map((issue) => issue.uuid);
        const includedIds = new Set(included);

        return {
            prompt: kept.length ? buildFixPrompt(kept) : '',
            included,
            skipped: wanted.filter((id) => !includedIds.has(id)),
        };
    }
}
