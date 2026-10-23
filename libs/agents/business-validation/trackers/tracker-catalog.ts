import type { MCPServerConfig } from '@libs/mcp-server/mcp-adapter';

import { AUTO_TASK_SOURCE } from '../settings';
import { type AgentToolReader, CustomMcpTracker } from './custom-mcp.tracker';
import { GIT_ISSUES_TOOLS, GitIssuesTracker } from './git-issues.tracker';
import { JIRA_TOOLS, JiraTracker } from './jira.tracker';
import { LINEAR_TOOLS, LinearTracker } from './linear.tracker';
import { McpToolSession } from './mcp-tool-session';
import { NOTION_TOOLS, NotionTracker } from './notion.tracker';
import type { TaskFinder } from './task-finder';
import type { BoundTaskFinder, McpTaskTracker, TaskTracker } from './tracker';

/** Managed catalog entries, by integration id (apps/mcp-manager/src/config/managed-mcp-servers.json). */
const MANAGED: Record<
    string,
    (server: MCPServerConfig, chosen?: boolean) => McpTaskTracker
> = {
    'kodus-issues-default': (server, chosen) =>
        new GitIssuesTracker(
            new McpToolSession(server, GIT_ISSUES_TOOLS),
            chosen,
        ),
    'linear-default': (server) =>
        new LinearTracker(new McpToolSession(server, LINEAR_TOOLS)),
    'atlassian-rovo-default': (server) =>
        new JiraTracker(new McpToolSession(server, JIRA_TOOLS)),
    'notion-default': (server) =>
        new NotionTracker(new McpToolSession(server, NOTION_TOOLS)),
};

/**
 * Names that marked a custom plugin as a task tracker before plugins could say
 * so themselves. Kept so the plugins that work today keep working; a plugin
 * whose name says nothing (e.g. "Azure DevOps") is not used until the org
 * picks it as the task source (#1884).
 */
const CUSTOM_TRACKER_HINTS = [
    'jira',
    'linear',
    'notion',
    'clickup',
    'atlassianrovo',
    'githubissues',
];

export interface TaskSourceOptions {
    /** `auto`, or the integration id of the one plugin the org reads tasks from. */
    taskSource?: string;
    /** The tool that reads a task by id, for a custom plugin. */
    taskSourceTool?: string;
    agentReader?: AgentToolReader;
    /** Looks for a task a tracker's direct read missed. */
    finder?: TaskFinder;
}

/**
 * The task trackers among an organization's MCP connections, in connection
 * order. With a task source chosen, only that one (#1884): a custom plugin
 * then needs no name hint, and reads with the tool the org picked.
 */
export function buildTaskTrackers(
    servers: MCPServerConfig[],
    options: TaskSourceOptions = {},
): TaskTracker[] {
    const source = options.taskSource ?? AUTO_TASK_SOURCE;
    if (source !== AUTO_TASK_SOURCE) {
        const server = servers.find((s) => s.integrationId === source);
        if (!server) {
            return [];
        }
        const tracker = chosenTracker(server, options);
        // The admin named the one tool a custom plugin reads with: keep to it.
        return [
            options.taskSourceTool && !isManagedTracker(server)
                ? tracker
                : withFinder(tracker, server, options.finder),
        ];
    }
    const trackers: TaskTracker[] = [];
    for (const server of servers) {
        const managed = server.integrationId
            ? MANAGED[server.integrationId]
            : undefined;
        if (managed) {
            trackers.push(withFinder(managed(server), server, options.finder));
            continue;
        }
        if (server.provider === 'custom' && isTaskPlugin(server)) {
            trackers.push(
                withFinder(
                    new CustomMcpTracker(
                        server.name,
                        new McpToolSession(server),
                    ),
                    server,
                    options.finder,
                ),
            );
        }
    }
    return trackers;
}

function chosenTracker(
    server: MCPServerConfig,
    options: TaskSourceOptions,
): McpTaskTracker {
    const managed = server.integrationId
        ? MANAGED[server.integrationId]
        : undefined;
    if (managed) {
        return managed(server, true);
    }
    const tool = options.taskSourceTool;
    return new CustomMcpTracker(
        server.name,
        new McpToolSession(server, tool ? [tool] : undefined),
        tool,
        tool ? options.agentReader : undefined,
        true,
    );
}

/** Whether a connection is one of the trackers Kodus reads natively. */
export function isManagedTracker(server: MCPServerConfig): boolean {
    return !!server.integrationId && server.integrationId in MANAGED;
}

/** Connections that can be a task source: managed trackers and every custom plugin. */
export function taskSourceCandidates(
    servers: MCPServerConfig[],
): MCPServerConfig[] {
    return servers.filter(
        (s) => isManagedTracker(s) || s.provider === 'custom',
    );
}

/** Whether `auto` reads tasks from this connection. */
export function isAutoTracker(server: MCPServerConfig): boolean {
    return (
        isManagedTracker(server) ||
        (server.provider === 'custom' && isTaskPlugin(server))
    );
}

function isTaskPlugin(server: MCPServerConfig): boolean {
    if (server.category === 'task-management') {
        return true;
    }
    const name = server.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    return CUSTOM_TRACKER_HINTS.some((hint) => name.includes(hint));
}

function withFinder(
    tracker: McpTaskTracker,
    server: MCPServerConfig,
    finder: TaskFinder | undefined,
): McpTaskTracker {
    return finder
        ? tracker.useFinder(bindFinder(server, tracker.name, finder))
        : tracker;
}

/**
 * The finder on its own session to `server`, open to every tool the org
 * allows; the finder offers the agent only the read-only ones.
 */
function bindFinder(
    server: MCPServerConfig,
    trackerName: string,
    finder: TaskFinder,
): BoundTaskFinder {
    return async (reference, context) => {
        const session = new McpToolSession(server);
        try {
            return await finder({
                reference,
                tracker: trackerName,
                repository:
                    reference.kind === 'git_issue'
                        ? (reference.repository ?? context.repository)
                        : undefined,
                tools: await session.tools(),
                call: (name, args) => session.call(name, args),
                signal: context.signal,
            });
        } finally {
            await session.close();
        }
    };
}
