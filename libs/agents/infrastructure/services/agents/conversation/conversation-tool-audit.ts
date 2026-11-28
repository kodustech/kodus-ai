/**
 * Audit seam for the conversation agent's mutating tools.
 *
 * The agent may now propose actions, so a turn can change org-level state
 * (memories, rules, issues). Every such call is reported before it is answered
 * for, including the destructive tools the agent is never told to offer — those
 * are exactly the ones worth seeing in a log.
 *
 * Which tools those are is NOT listed here: it comes from each tool's own MCP
 * `readOnlyHint`. An MCP tool that does not declare one is treated as a write,
 * so a server that omits its annotations is over-logged rather than silently
 * unaudited. Tools that never came from MCP at all — the sandbox's grep,
 * readFile, listDir and exec — are not org state and stay out of this entirely.
 */
import type { Tool } from 'ai';

import type { McpToolMetadata } from '../../ai-sdk/mcp-tools';

export interface WriteToolEvent {
    tool: string;
    args: unknown;
    /** What the tool returned, so the reply can quote a real link. */
    result?: string;
    /** Present when the tool threw; the error is re-thrown either way. */
    error?: string;
}

/** The write tools that ran and returned: what the turn really changed. */
export function performedWrites(writes: readonly WriteToolEvent[]): string[] {
    return writes.filter((w) => w.error === undefined).map((w) => w.tool);
}

export function isConversationWriteTool(
    metadata: McpToolMetadata | undefined,
): boolean {
    return metadata?.readOnlyHint !== true;
}

/**
 * Whether a bound tool changes org state, by name. Presence in the metadata map
 * is what marks a tool as MCP-served: `connectMcpTools` records an entry for
 * every tool it connects, even an empty one, so an absent key means the tool is
 * local (sandbox) rather than a server that forgot to annotate.
 */
export function writeToolPredicate(
    metadata: Record<string, McpToolMetadata>,
): (name: string) => boolean {
    return (name) =>
        Object.prototype.hasOwnProperty.call(metadata, name) &&
        isConversationWriteTool(metadata[name]);
}

/**
 * Return the tool map with every write tool wrapped so `onWrite` sees the call.
 * Read tools are passed through by reference — nothing to audit, nothing to pay.
 */
export function auditWriteTools(
    tools: Record<string, Tool>,
    metadata: Record<string, McpToolMetadata>,
    onWrite: (event: WriteToolEvent) => void,
): Record<string, Tool> {
    const audited: Record<string, Tool> = {};

    const isWrite = writeToolPredicate(metadata);

    for (const [name, tool] of Object.entries(tools)) {
        if (!isWrite(name) || typeof tool.execute !== 'function') {
            audited[name] = tool;
            continue;
        }

        const execute = tool.execute.bind(tool);
        audited[name] = {
            ...tool,
            execute: async (args: never, options: never) => {
                try {
                    const result = await execute(args, options);
                    onWrite({
                        tool: name,
                        args,
                        result:
                            typeof result === 'string'
                                ? result
                                : JSON.stringify(result ?? null),
                    });
                    return result;
                } catch (error) {
                    onWrite({
                        tool: name,
                        args,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    });
                    throw error;
                }
            },
        } as Tool;
    }

    return audited;
}

/**
 * How the turn's declared decisions and the writes that ran disagree, if they
 * do. `unperformed` (an `act` on a write that was never attempted) and
 * `undeclared` (a write while the final decision was not `act`) are the
 * failures the decision exists to catch. `failed` is an `act` whose write was
 * attempted and refused or thrown: the tool already reported that, and the
 * agent saw the error.
 *
 * The trailing run of `act` decisions counts, not just the last one: a later
 * `act` replaces the write an earlier one authorized (`grant` keeps one tool),
 * so `act` on a write followed by `act` on `exec` is exactly the run that
 * leaves the write undone. An `act` followed by `offer` or `answer` was
 * retracted and does not count. An `act` on a read followed by a call to a
 * write tool is compared too: that write was refused, since the act did not
 * name it. An `act` naming a tool that only reads (the sandbox `exec`, `grep`)
 * is not compared on its own: no write was ever going to run for it. A name
 * the run does not know is compared, so a write declared under a wrong name
 * stays visible.
 */
export type DecisionDivergence =
    | { kind: 'unperformed'; tool?: string }
    | { kind: 'failed'; tools: string[] }
    | { kind: 'undeclared'; tools: string[] };

export function decisionDivergence(
    decisions: readonly { intent: string; tool?: string }[],
    writes: readonly WriteToolEvent[],
    isReadOnlyTool: (name: string) => boolean,
    /** Write tools the run called, refused ones included (the audit sees only allowed calls). */
    calledWriteTools: readonly string[] = [],
): DecisionDivergence | undefined {
    const performed = performedWrites(writes);
    // The acts the run ended on. An act the agent then retracted (`offer`
    // or `answer` after it, which is what a refused write is told to do)
    // is not compared.
    const lastOther = decisions.findLastIndex((d) => d.intent !== 'act');
    const acts = decisions.slice(lastOther + 1);

    if (acts.length > 0 && performed.length === 0) {
        if (writes.length > 0) {
            return { kind: 'failed', tools: writes.map((w) => w.tool) };
        }
        const writeActs = acts.filter(
            (d) => !d.tool || !isReadOnlyTool(d.tool),
        );
        if (writeActs.length > 0) {
            return { kind: 'unperformed', tool: writeActs.at(-1)?.tool };
        }
        // The act named a read, but the run then called a write. The act
        // grants only the tool it names, so that write was refused before
        // the audit saw it (one that threw is `failed` above): the agent
        // may still tell the developer it saved something.
        const refused = calledWriteTools.at(-1);
        return refused ? { kind: 'unperformed', tool: refused } : undefined;
    }

    if (decisions.at(-1)?.intent !== 'act' && performed.length > 0) {
        return { kind: 'undeclared', tools: performed };
    }

    return undefined;
}
