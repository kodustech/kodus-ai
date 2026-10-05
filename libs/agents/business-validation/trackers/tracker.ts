import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import type {
    TaskReference,
    TrackerLookup,
} from '../business-validation.types';
import { McpToolSession, TaskNotFoundError } from './mcp-tool-session';

export interface TrackerReadContext {
    organizationAndTeamData: OrganizationAndTeamData;
    /** The PR's repository, for references like `#12`. */
    repository?: { owner?: string; name: string };
}

/**
 * A connected task tracker. It reads one task by its id and confirms the task
 * it got back is the one asked for. It never lists or searches: a list that
 * returns "some task" is how a PR got validated against an unrelated issue.
 */
export interface TaskTracker {
    readonly name: string;
    canRead(reference: TaskReference): boolean;
    read(
        reference: TaskReference,
        context: TrackerReadContext,
    ): Promise<TrackerLookup>;
    close(): Promise<void>;
}

/** Shared lifecycle and error mapping for trackers behind one MCP server. */
export abstract class McpTaskTracker implements TaskTracker {
    abstract readonly name: string;

    constructor(protected readonly session: McpToolSession) {}

    abstract canRead(reference: TaskReference): boolean;

    protected abstract lookup(
        reference: TaskReference,
        context: TrackerReadContext,
    ): Promise<TrackerLookup>;

    async read(
        reference: TaskReference,
        context: TrackerReadContext,
    ): Promise<TrackerLookup> {
        try {
            return await this.lookup(reference, context);
        } catch (error) {
            if (error instanceof TaskNotFoundError) {
                return { status: 'not_found' };
            }
            return {
                status: 'error',
                message: error instanceof Error ? error.message : String(error),
            };
        }
    }

    close(): Promise<void> {
        return this.session.close();
    }
}
