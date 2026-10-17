import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import type {
    RelatedTask,
    Task,
    TaskReference,
    TrackerLookup,
} from '../business-validation.types';
import { createLogger } from '@libs/core/log/logger';

import { McpToolSession, TaskNotFoundError } from './mcp-tool-session';
import type { FoundByFinder } from './task-finder';

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
     * a missing `SAA-999` reads as a typo and `UTF-8` doesn't. Undefined (or
     * absent) when the tracker can't list its keys; rejects when listing them
     * failed, so an outage is never read as "not ours".
     */
    ownsReference?(
        reference: TaskReference,
        context: TrackerReadContext,
    ): Promise<boolean | undefined>;
    /**
     * A second look, by an agent, at a reference the direct read missed.
     * Undefined when there is nothing to try or it found nothing.
     */
    find?(
        reference: TaskReference,
        context: TrackerReadContext,
        direct: TrackerLookup,
    ): Promise<TrackerLookup | undefined>;
    /**
     * Reads what a found task links to (its parent, sub-tasks, attached
     * documents) through the same tools, and drops the raw links.
     */
    relate?(task: Task, context: TrackerReadContext): Promise<Task>;
    close(): Promise<void>;
}

/**
 * Looks for a task the direct read missed, through the server's read-only
 * tools. Bound to one server by the catalog.
 */
export type BoundTaskFinder = (
    reference: TaskReference,
    context: TrackerReadContext,
) => Promise<FoundByFinder | undefined>;

/** A failure no other tool or argument fixes: the server is down, slow or refuses us. */
const UNREACHABLE =
    /time[sd]?\s?out|ECONN|ENOTFOUND|EAI_AGAIN|socket|fetch failed|network|\b5\d\d\b|\b429\b|rate.?limit|unauthori[sz]ed|\b401\b|\b403\b|forbidden|expired|invalid.?token|connect/i;

const logger = createLogger('McpTaskTracker');

/** Attached documents read per task; more is a wiki, not this task's spec. */
const MAX_DOCUMENTS = 3;
/** A parent or a document longer than this is cut: it is context, not the task. */
const MAX_RELATED_CHARS = 6_000;

function clipText(text: string): string {
    return text.length > MAX_RELATED_CHARS
        ? `${text.slice(0, MAX_RELATED_CHARS)}… (cut)`
        : text;
}

const READ_ATTEMPTS = 2;
const READ_BUDGET_MS = 30_000;
const RETRY_DELAY_MS = 1_000;

/** Shared lifecycle and error mapping for trackers behind one MCP server. */
export abstract class McpTaskTracker implements TaskTracker {
    abstract readonly name: string;

    private finder?: BoundTaskFinder;

    constructor(protected readonly session: McpToolSession) {}

    /** Lets an agent look for a task the direct read missed. */
    useFinder(finder: BoundTaskFinder): this {
        this.finder = finder;
        return this;
    }

    abstract canRead(reference: TaskReference): boolean;

    protected abstract lookup(
        reference: TaskReference,
        context: TrackerReadContext,
    ): Promise<TrackerLookup>;

    /**
     * Asks the task finder agent for a task the direct read missed. Called
     * by the resolver only after no tracker read the reference directly.
     */
    async find(
        reference: TaskReference,
        context: TrackerReadContext,
        direct: TrackerLookup,
    ): Promise<TrackerLookup | undefined> {
        if (!this.finder || !worthFinding(direct)) {
            return undefined;
        }
        if (
            direct.status === 'not_found' &&
            reference.kind === 'key' &&
            (await this.ownsReference(reference, context).catch((error) => {
                // Can't tell whose key it is: the agent may still look.
                warnFailure(
                    this.name,
                    'list its keys',
                    reference.id,
                    context,
                    error,
                );
                return undefined;
            })) === false
        ) {
            // `KOD-10` with no team KOD here: another tracker's, nothing to find.
            return undefined;
        }
        const found = await this.finder(reference, context).catch((error) => {
            // The direct read stands as the tracker's answer.
            warnFailure(
                this.name,
                'run the task finder',
                reference.id,
                context,
                error,
            );
            return undefined;
        });
        if (!found) {
            return undefined;
        }
        if ('notFound' in found) {
            // The server answered and has no such task: a miss, not an outage.
            return {
                status: 'not_found',
                tools: [...(direct.tools ?? []), ...found.tools],
                byAgent: true,
            };
        }
        // The direct read is the cheap path; when the agent had to step in,
        // the server changed and this tracker should learn its new shape.
        logger.warn({
            message: `[BUSINESS-LOGIC] ${this.name} read ${reference.id} only through the task finder; its direct read ${direct.status === 'error' ? `failed (${direct.message})` : 'found nothing'}`,
            context: 'McpTaskTracker',
            metadata: {
                organizationId: context.organizationAndTeamData?.organizationId,
                tracker: this.name,
                directTools: direct.tools,
                finderTools: found.tools,
            },
        });
        return {
            status: 'found',
            task: { ...found.task, tracker: this.name },
            tools: [...(direct.tools ?? []), ...found.tools],
            byAgent: true,
        };
    }

    /**
     * Two tries within the budget: a tracker that hiccups once still
     * answers; one that is down fails fast instead of holding the review.
     */
    async read(
        reference: TaskReference,
        context: TrackerReadContext,
    ): Promise<TrackerLookup> {
        const deadline = Date.now() + READ_BUDGET_MS;
        const firstCall = this.session.called.length;
        const tools = () => [...new Set(this.session.called.slice(firstCall))];
        let message = '';
        for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
            try {
                return {
                    ...(await this.lookup(reference, context)),
                    tools: tools(),
                };
            } catch (error) {
                if (error instanceof TaskNotFoundError) {
                    return { status: 'not_found', tools: tools() };
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
        return { status: 'error', message, tools: tools() };
    }

    /**
     * The parent read whole, the sub-tasks by title, and attached documents
     * folded into the description, so a sub-issue that says "see the parent"
     * or a task whose spec is a doc can still be judged. Each read is best
     * effort: a miss leaves the task as it was found.
     */
    async relate(task: Task, context: TrackerReadContext): Promise<Task> {
        const { links, ...found } = task;
        if (!links && !this.childrenOf) {
            return found;
        }
        const [parent, subtasks, documents] = await Promise.all([
            this.parentOf(found, links, context),
            links?.subtasks?.length
                ? Promise.resolve(links.subtasks)
                : (this.childrenOf?.(found).catch((error) => {
                      warnFailure(
                          this.name,
                          'read sub-tasks',
                          found.id,
                          context,
                          error,
                      );
                      return [];
                  }) ?? Promise.resolve([])),
            Promise.all(
                (links?.documents ?? [])
                    .slice(0, MAX_DOCUMENTS)
                    .map(async (doc) => {
                        const content =
                            doc.content ??
                            (await this.documentText?.(doc.id).catch(
                                (error) => {
                                    warnFailure(
                                        this.name,
                                        `read document ${doc.id}`,
                                        found.id,
                                        context,
                                        error,
                                    );
                                    return undefined;
                                },
                            ));
                        return content?.trim()
                            ? `## Document: ${doc.title ?? doc.id}\n\n${clipText(content)}`
                            : undefined;
                    }),
            ),
        ]);
        const attached = documents.filter((d): d is string => !!d);
        return {
            ...found,
            ...(attached.length
                ? {
                      description: [found.description, ...attached]
                          .filter(Boolean)
                          .join('\n\n'),
                  }
                : {}),
            ...(parent ? { parent } : {}),
            ...(subtasks.length ? { subtasks } : {}),
        };
    }

    private async parentOf(
        task: Task,
        links: Task['links'],
        context: TrackerReadContext,
    ): Promise<RelatedTask | undefined> {
        const id = links?.parentId;
        if (!id || id.toUpperCase() === task.id.toUpperCase()) {
            return undefined;
        }
        const read = await this.lookup(
            { kind: 'key', id, raw: id, source: 'body', intent: 'mentions' },
            context,
        ).catch((error) => {
            warnFailure(
                this.name,
                `read parent ${id}`,
                task.id,
                context,
                error,
            );
            return undefined;
        });
        if (read?.status !== 'found') {
            return { id, title: links?.parentTitle };
        }
        return {
            id: read.task.id,
            title: read.task.title ?? links?.parentTitle,
            description: read.task.description
                ? clipText(read.task.description)
                : undefined,
        };
    }

    /** The task's sub-tasks, for a tracker whose answer doesn't list them. */
    protected childrenOf?(task: Task): Promise<RelatedTask[]>;
    /** A document attached to the task, for a tracker that names docs by id. */
    protected documentText?(id: string): Promise<string | undefined>;

    /** The tracker's team or project keys (`SAA`), when it can list them. */
    protected projectKeys?(): Promise<string[]>;
    private keys?: Promise<string[]>;

    async ownsReference(
        reference: TaskReference,
        _context?: TrackerReadContext,
    ): Promise<boolean | undefined> {
        if (reference.kind !== 'key') {
            return false;
        }
        if (!this.projectKeys) {
            return undefined;
        }
        // A failed listing rejects, for every caller of this run: a tracker
        // that is down has not said the key isn't its own.
        this.keys ??= this.projectKeys();
        const prefix = reference.id.split('-')[0];
        return (await this.keys).some((key) => key.toUpperCase() === prefix);
    }

    close(): Promise<void> {
        return this.session.close();
    }
}

/** A best-effort read that failed: the run goes on without it, the log keeps it. */
function warnFailure(
    tracker: string,
    what: string,
    taskId: string,
    context: TrackerReadContext,
    error: unknown,
): void {
    logger.warn({
        message: `[BUSINESS-LOGIC] ${tracker} could not ${what} for ${taskId}`,
        context: 'McpTaskTracker',
        error: error instanceof Error ? error : undefined,
        metadata: {
            organizationId: context.organizationAndTeamData?.organizationId,
            tracker,
            taskId,
            reason: error instanceof Error ? error.message : String(error),
        },
    });
}

/**
 * A miss another tool or argument might fix: nothing found, or a failure that
 * isn't the server being down or refusing us. A plugin set up with no reader
 * is the admin's to fix.
 */
function worthFinding(lookup: TrackerLookup): boolean {
    if (lookup.status === 'not_found') {
        return true;
    }
    return (
        lookup.status === 'error' &&
        !lookup.setup &&
        !UNREACHABLE.test(lookup.message)
    );
}
