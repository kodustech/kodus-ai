/**
 * A task-resolution case: a pull request, the trackers the org connected, and
 * what a developer should see. It describes behavior, not implementation, so
 * the same file can drive today's stage and the resolver that replaces it.
 */

export type TrackerTask = {
    /** The id people write: "SAA-96", "PROJ-12", "8". */
    id: string;
    title: string;
    description?: string;
    acceptanceCriteria?: string[];
};

/**
 * How a tool answers. `get` looks the task up by the value of `idArg`; `list`
 * returns every task; `write` changes nothing but is recorded, so a case can
 * assert the fetch never wrote to the customer's tracker.
 */
export type TrackerTool = {
    name: string;
    kind: 'get' | 'list' | 'write';
    description?: string;
    idArg?: string;
    /** For a tool with an `action` enum (Azure `wit_work_item`): the only
     *  action value that reads. Any other value is a write. */
    readAction?: string;
    inputSchema?: Record<string, unknown>;
};

export type TrackerFixture = {
    integrationId: string;
    appName: string;
    /** 'kodusmcp' for a managed catalog entry, 'custom' for a customer plugin. */
    provider: 'kodusmcp' | 'custom';
    category: 'task-management' | null;
    /** The JSON the real server wraps a task in. */
    responseShape: 'linear' | 'jira' | 'azure';
    tools: TrackerTool[];
    /** Write tools added by name only, to reproduce a server's full surface. */
    extraWriteTools?: string[];
    tasks: TrackerTask[];
    /** The server answers every request with 503 (outage, expired token). */
    unavailable?: boolean;
};

export type ResolutionFixture = {
    name: string;
    /** The issue this case reproduces. */
    issue: string;
    /** Whether today's code already behaves as expected (a guard, not a repro). */
    passesOnMain: boolean;
    repository: {
        id: string;
        name: string;
        owner: string;
        /** The repo's own issues and PRs, in the order GitHub lists them. */
        issues?: Array<{
            number: number;
            title: string;
            body?: string;
            isPullRequest?: boolean;
        }>;
    };
    /** Kodus's Git Issues MCP connected for this org. */
    gitIssuesConnected?: boolean;
    trackers: TrackerFixture[];
    /**
     * Business Logic settings the org saved. Today's code has none, so its
     * driver ignores this; the resolver reads it.
     */
    settings?: {
        /** 'managed' (default) or the integrationId of one plugin. */
        taskSource?: string;
        /** For a custom plugin: the tool that reads a task by its id. */
        lookupTool?: string;
    };
    pullRequest: {
        number: number;
        title: string;
        body: string;
        branch: string;
        files: Array<{ filename: string; patch: string }>;
    };
    expect: {
        /**
         * - `validated`: the task reached the judge.
         * - `comment`: no validation, and a comment is posted on the PR.
         * - `silent`: no validation and no comment.
         */
        outcome: 'validated' | 'comment' | 'silent';
        // Every case also asserts that no tool wrote to a tracker.
        /** For `validated`: text that must, and must not, be in what the judge read. */
        taskContains?: string[];
        taskNotContains?: string[];
        /** For `comment`: text the comment must contain. */
        commentContains?: string[];
        /** Comments that must never be posted for this case. */
        commentNotContains?: string[];
    };
};
