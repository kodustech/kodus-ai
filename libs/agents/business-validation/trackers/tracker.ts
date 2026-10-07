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
    /**
     * Whether the reference's prefix is a team or project in this tracker, so
     * a missing `SAA-999` reads as a typo and `UTF-8` doesn't. Absent when the
     * tracker can't tell.
     */
    ownsReference?(
        reference: TaskReference,
        context: TrackerReadContext,
    ): Promise<boolean>;
    close(): Promise<void>;
}

const READ_ATTEMPTS = 2;
const READ_BUDGET_MS = 30_000;
const RETRY_DELAY_MS = 1_000;

/** Shared lifecycle and error mapping for trackers behind one MCP server. */
export abstract class McpTaskTracker implements TaskTracker {
    abstract readonly name: string;

    constructor(protected readonly session: McpToolSession) {}

    abstract canRead(reference: TaskReference): boolean;

    protected abstract lookup(
        reference: TaskReference,
        context: TrackerReadContext,
    ): Promise<TrackerLookup>;

    /**
     * Two tries within the budget: a tracker that hiccups once still
     * answers; one that is down fails fast instead of holding the review.
     */
    async read(
        reference: TaskReference,
        context: TrackerReadContext,
    ): Promise<TrackerLookup> {
        const deadline = Date.now() + READ_BUDGET_MS;
        let message = '';
        for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
            try {
                return await this.lookup(reference, context);
            } catch (error) {
                if (error instanceof TaskNotFoundError) {
                    return { status: 'not_found' };
                }
                message =
                    error instanceof Error ? error.message : String(error);
                if (Date.now() + RETRY_DELAY_MS >= deadline) {
                    break;
                }
                await new Promise((resolve) =>
                    setTimeout(resolve, RETRY_DELAY_MS).unref?.(),
                );
            }
        }
        return { status: 'error', message };
    }

    /** The tracker's team or project keys (`SAA`), when it can list them. */
    protected projectKeys?(): Promise<string[]>;
    private keys?: Promise<string[]>;

    async ownsReference(reference: TaskReference): Promise<boolean> {
        if (reference.kind !== 'key' || !this.projectKeys) {
            return false;
        }
        this.keys ??= this.projectKeys().catch(() => []);
        const prefix = reference.id.split('-')[0];
        return (await this.keys).some((key) => key.toUpperCase() === prefix);
    }

    close(): Promise<void> {
        return this.session.close();
    }
}
