import { extractTaskReferences } from '@libs/agents/business-validation/task-references';
import { resolveTasks } from '@libs/agents/business-validation/task-resolver';
import { buildTaskTrackers } from '@libs/agents/business-validation/trackers/tracker-catalog';
import type { TaskResolution } from '@libs/agents/business-validation/business-validation.types';
import type { TaskTracker } from '@libs/agents/business-validation/trackers/tracker';
import { createLogger } from '@libs/core/log/logger';
import type { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';

import type { LinkedTask, OrgTeam, RuntimeLinkedTasksReader } from '../domain/ports';

/** The Run request's bounds (run-messages.ts pullRequest.linkedTasks). */
const MAX_TASKS = 3;
const MAX_BODY = 16_384;
const MAX_TITLE = 1_024;

type Closable = TaskTracker & { close?: () => Promise<void> };
type Input = Parameters<RuntimeLinkedTasksReader['read']>[0];

/** What the adapter is made of; the defaults are business validation's own readers. */
export interface LinkedTasksParts {
    connections: (org: OrgTeam) => Promise<unknown[]>;
    trackers: (servers: unknown[]) => Closable[];
    resolve: (input: Input, trackers: Closable[]) => Promise<TaskResolution>;
}

const cut = (text: string, max: number) => {
    let out = '';
    for (const ch of text) {
        if (out.length + ch.length > max) break;
        out += ch;
    }
    return out;
};

/**
 * Business validation's references and tracker reads, without its model: no
 * agent reader, no finder (the Runtime never spends the org's model here).
 * A reference no connected tracker confirms is dropped, as there.
 */
export class LinkedTasksAdapter implements RuntimeLinkedTasksReader {
    private readonly logger = createLogger(LinkedTasksAdapter.name);

    constructor(private readonly parts: LinkedTasksParts) {}

    /** The product's readers: the org's MCP connections, the managed trackers, no model. */
    static fromMcp(mcp: Pick<MCPManagerService, 'getConnections'>): LinkedTasksAdapter {
        return new LinkedTasksAdapter({
            connections: async (org) => (await mcp.getConnections({ organizationId: org.organizationId, teamId: org.teamId })) ?? [],
            trackers: (servers) => buildTaskTrackers(servers as never) as Closable[],
            resolve: (input, trackers) => {
                const references = extractTaskReferences({ title: input.title, branch: input.headBranch, body: input.description });
                const [owner, name] = input.repositoryName.includes('/') ? input.repositoryName.split('/', 2) : [undefined, input.repositoryName];
                return resolveTasks(references, trackers, {
                    organizationAndTeamData: { organizationId: input.organizationId, teamId: input.teamId },
                    repository: { ...(owner ? { owner } : {}), name },
                });
            },
        });
    }

    async read(input: Input): Promise<LinkedTask[]> {
        const trackers = this.parts.trackers(await this.parts.connections(input));
        try {
            const resolution = await this.parts.resolve(input, trackers);
            if (resolution.kind !== 'found') return [];
            return resolution.tasks.slice(0, MAX_TASKS).map(({ task }) => {
                const criteria = task.acceptanceCriteria?.length ? `\n\nAcceptance criteria:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}` : '';
                return {
                    source: cut(task.tracker, 32),
                    id: cut(task.id, 256),
                    ...(task.title ? { title: cut(task.title, MAX_TITLE) } : {}),
                    body: cut(`${task.description ?? ''}${criteria}`.trim(), MAX_BODY),
                };
            });
        } finally {
            const closed = await Promise.allSettled(trackers.map((t) => t.close?.()));
            if (closed.some((c) => c.status === 'rejected')) this.logger.warn({ message: 'Runtime linked tasks: a tracker did not close', context: LinkedTasksAdapter.name, metadata: { organizationId: input.organizationId } });
        }
    }
}
