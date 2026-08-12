import crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import {
    ITraceDecisionBranchReader,
    ReadTraceDecisionBranchInput,
    TraceDecisionBranchRecord,
} from '../../domain/contracts/trace-decision-branch-reader.contract';

export const TRACE_BRANCH = 'kodus/trace/v1';

export function traceRecordPath(branch: string): string {
    const hash = crypto.createHash('sha256').update(branch).digest('hex');
    return `records/${hash.slice(0, 2)}/${hash}.json`;
}

/**
 * Reads the exact branch shard through the configured code-host adapter. The
 * organization/team credentials and repository id are mandatory inputs, so a
 * lookup cannot fan out across tenants or repositories.
 */
@Injectable()
export class TraceDecisionBranchReaderService implements ITraceDecisionBranchReader {
    constructor(
        private readonly codeManagementService: CodeManagementService,
    ) {}

    async read(
        input: ReadTraceDecisionBranchInput,
    ): Promise<TraceDecisionBranchRecord | null> {
        const branch = input.branch?.trim().replace(/^refs\/heads\//, '');
        if (
            !input.organizationAndTeamData.organizationId ||
            !input.organizationAndTeamData.teamId ||
            !input.repository?.id ||
            !input.repository?.name ||
            !branch
        ) {
            return null;
        }

        const response =
            await this.codeManagementService.getRepositoryContentFile({
                organizationAndTeamData: input.organizationAndTeamData,
                repository: input.repository,
                file: { filename: traceRecordPath(branch) },
                pullRequest: {
                    // All supported review providers already resolve file
                    // content from head/base refs through this abstraction.
                    head: { ref: TRACE_BRANCH },
                    base: { ref: TRACE_BRANCH },
                },
            });

        const raw = decodeContent(response);
        if (!raw) {
            return null;
        }

        try {
            const parsed = JSON.parse(
                raw,
            ) as Partial<TraceDecisionBranchRecord>;
            if (
                parsed.version !== 1 ||
                parsed.branch !== branch ||
                !Array.isArray(parsed.decisions)
            ) {
                return null;
            }
            return parsed as TraceDecisionBranchRecord;
        } catch {
            return null;
        }
    }
}

function decodeContent(response: any): string | null {
    const content = response?.data?.content ?? response?.content ?? response;
    if (typeof content !== 'string' || content.length === 0) {
        return null;
    }

    return response?.data?.encoding === 'base64'
        ? Buffer.from(content, 'base64').toString('utf-8')
        : content;
}
