import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { TraceContextDecision } from '../types/trace-context.types';

export const TRACE_DECISION_BRANCH_READER_TOKEN = Symbol(
    'TRACE_DECISION_BRANCH_READER_TOKEN',
);

export interface ReadTraceDecisionBranchInput {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: { id: string; name: string };
    /** Destination branch key written by the CLI pre-push hook. */
    branch: string;
}

export interface TraceDecisionBranchRecord {
    version: 1;
    branch: string;
    decisions: TraceContextDecision[];
}

/** Repository-scoped read access to the shared `kodus/trace/v1` ref. */
export interface ITraceDecisionBranchReader {
    read(
        input: ReadTraceDecisionBranchInput,
    ): Promise<TraceDecisionBranchRecord | null>;
}
