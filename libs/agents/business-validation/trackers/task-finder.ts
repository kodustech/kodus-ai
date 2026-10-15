import type { AgentSpec } from '@libs/agent-harness/domain/contracts/agent.contract';
import type { JSONSchema } from '@libs/agent-harness/domain/contracts/json-schema.contract';
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';
import { createAgentRunContext } from '@libs/llm/agent-run-context';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { createLogger } from '@libs/core/log/logger';
import type { MCPToolRaw } from '@libs/mcp-server/mcp-adapter';

import type { Task, TaskReference } from '../business-validation.types';
import { asRecord } from '../value-utils';
import { isReadOnly, isSingleItemReader, taskId } from './custom-mcp.tracker';
import { TaskNotFoundError } from './mcp-tool-session';
import {
    carriesDescription,
    describeTask,
    recordWithId,
    textField,
} from './task-payload';

const MAX_STEPS = 8;
const TIMEOUT_MS = 45_000;
/** A server with more tools than this is cut to its readers first. */
const MAX_TOOLS = 40;
const MAX_OUTPUT_CHARS = 6000;

const logger = createLogger('TaskFinder');

export interface TaskFinderInput {
    reference: TaskReference;
    tracker: string;
    /** The PR's repository, for `#12`. */
    repository?: { owner?: string; name: string };
    /** Every tool the server lists; only the read-only ones are offered. */
    tools: MCPToolRaw[];
    call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export type FoundByFinder =
    | {
          task: Omit<Task, 'tracker'>;
          /** Every tool the agent called, in order. */
          tools: string[];
      }
    /** The server answered, and the agent reports there is no such task. */
    | { notFound: true; tools: string[] };

const NOT_FOUND_TOOL = 'report_task_not_found';

/**
 * Finds one task when the tracker's direct read didn't: a renamed tool, an
 * answer in a new shape, an argument the server now requires. An agent that
 * can call only the server's read-only tools looks for it, and its work is
 * accepted only when a tool returned a record whose own id is the one asked
 * for. A list that returns "some task" never counts.
 */
export type TaskFinder = (
    input: TaskFinderInput,
) => Promise<FoundByFinder | undefined>;

/** Runs the agent; injected so tests and evals can drive it. */
export type AgentRun = (spec: AgentSpec, prompt: string) => Promise<void>;

export function createTaskFinder(run: AgentRun): TaskFinder {
    return async (input) => {
        const { reference } = input;
        // Readers of one item first, so a cut never drops the one that reads it.
        const readable = readOnlyTools(input.tools)
            .sort(
                (a, b) =>
                    Number(isSingleItemReader(b)) -
                    Number(isSingleItemReader(a)),
            )
            .slice(0, MAX_TOOLS);
        if (!readable.length) {
            return undefined;
        }
        const allowed = new Set(readable.map((t) => t.name));
        const called: string[] = [];
        let found: Omit<Task, 'tracker'> | undefined;
        let answered = false;
        let reportedMissing = false;

        const registry = new InMemoryToolRegistry([
            {
                name: NOT_FOUND_TOOL,
                description: `Report that ${reference.raw} does not exist in ${input.tracker}, after a tool answered without it.`,
                inputSchema: { type: 'object', properties: {} } as JSONSchema,
                execute: async () => {
                    reportedMissing = true;
                    return { output: 'Noted. Answer NOT_FOUND.' };
                },
            },
            ...readable.map((tool) => ({
                name: tool.name,
                description: (tool.description ?? tool.name).slice(0, 800),
                inputSchema: (tool.inputSchema ?? {
                    type: 'object',
                }) as JSONSchema,
                execute: async (args: unknown) => {
                    if (found) {
                        return {
                            output: 'The task was already read. Answer DONE.',
                        };
                    }
                    if (!allowed.has(tool.name)) {
                        return {
                            output: 'Not a read-only tool.',
                            isError: true,
                        };
                    }
                    called.push(tool.name);
                    try {
                        const result = await input.call(
                            tool.name,
                            wholeItem(tool, asRecord(args)),
                        );
                        answered = true;
                        const accepted = acceptedTask(
                            result,
                            reference,
                            input.repository,
                        );
                        if (accepted?.complete) {
                            found = accepted.task;
                            return {
                                output: `That is ${reference.id}. Answer DONE.`,
                            };
                        }
                        // Taken without its description, the task would read
                        // as having no criteria and the author would be told
                        // to write some.
                        return {
                            output: accepted
                                ? `${clip(result)}\n\nThat is ${reference.id}, but without its description. Read it again with a tool that returns the whole item, without narrowing its fields.`
                                : clip(result),
                        };
                    } catch (error) {
                        const message =
                            error instanceof Error
                                ? error.message
                                : String(error);
                        // A tracker that says "not found" has answered.
                        answered ||= error instanceof TaskNotFoundError;
                        return { output: message, isError: true };
                    }
                },
            })),
        ]);

        await run(
            {
                id: 'business-rules-task-finder',
                agentName: 'BusinessRulesValidation',
                phase: 'taskFinder',
                runName: 'taskFinder',
                spanName: 'BusinessRulesValidation::taskFinder',
                systemPrompt: systemPrompt(input),
                tools: registry,
                policies: [],
                maxSteps: MAX_STEPS,
                maxOutputTokens: 800,
            },
            `Find ${reference.raw} in ${input.tracker}.`,
        ).catch((error) => {
            // A run cut short still keeps a task a tool already returned.
            logger.warn({
                message: `[BUSINESS-LOGIC] The task finder stopped early looking for ${reference.raw} in ${input.tracker}`,
                context: 'TaskFinder',
                error: error instanceof Error ? error : undefined,
                metadata: {
                    tracker: input.tracker,
                    reference: reference.raw,
                    found: !!found,
                    reason:
                        error instanceof Error ? error.message : String(error),
                },
            });
        });

        if (found) {
            return { task: found, tools: called };
        }
        // Only a server that answered can say a task is not there.
        return reportedMissing && answered
            ? { notFound: true, tools: called }
            : undefined;
    };
}

/** The agent runner a review uses: the judge's model, traced like it. */
export function aiSdkAgentRun(
    model: NormalizedModel | undefined,
    telemetry: { organizationId: string; teamId?: string },
): AgentRun {
    return async (spec, prompt) => {
        const { ctx, cleanup } = createAgentRunContext({
            runId: 'business-rules:task-finder',
            timeoutMs: TIMEOUT_MS,
        });
        try {
            await new AiSdkAgentRunner(model, {
                organizationId: telemetry.organizationId,
                provider: model?.provider,
            }).run(
                spec,
                {
                    prompt,
                    telemetryMetadata: {
                        ...telemetry,
                        provider: model?.provider,
                    },
                },
                ctx,
            );
        } finally {
            cleanup();
        }
    };
}

function systemPrompt(input: TaskFinderInput): string {
    const { reference, repository } = input;
    const where =
        reference.kind === 'git_issue' && repository
            ? ` It is issue #${reference.id} of the repository ${repository.owner ? `${repository.owner}/` : ''}${repository.name}.`
            : '';
    return [
        `You fetch one task from ${input.tracker} through its tools, so a pull request can be checked against it. The task is "${reference.raw}" (id ${reference.id}).${where}`,
        'Prefer a tool that reads one item by its id, and read the whole item: never narrow its fields. If it needs something you do not have yet (a site, cloud, workspace, team or project id), call a tool that lists those first.',
        'If a call fails, read the error and fix the arguments, or try another tool. The id may be expected in another form (lowercase, only the number, an internal id): a search or a list can show the form a reader expects.',
        `Stop as soon as a tool returned the task itself. Never stand in another task for this one: if the tools show it does not exist, call ${NOT_FOUND_TOOL} and answer NOT_FOUND.`,
        'You can only read; no tool you have changes anything. Answer DONE or NOT_FOUND, nothing else.',
    ].join('\n');
}

/**
 * A read of one item that can pick its fields asks for all of them: Jira
 * leaves custom fields, where teams keep criteria, out of its default answer,
 * and names them only when asked. A field list the server enumerates (Linear)
 * already answers in full by default.
 */
function wholeItem(
    tool: MCPToolRaw,
    args: Record<string, unknown>,
): Record<string, unknown> {
    if (MANY_ITEMS.test(tool.name)) {
        return args;
    }
    const properties = asRecord(asRecord(tool.inputSchema).properties);
    const fields = asRecord(properties.fields);
    const expand = asRecord(properties.expand);
    const whole = { ...args };
    if (
        fields.type === 'array' &&
        !Array.isArray(asRecord(fields.items).enum)
    ) {
        const asked = Array.isArray(args.fields) ? args.fields : [];
        whole.fields = asked.includes('*all') ? asked : [...asked, '*all'];
    }
    if (expand.type === 'string' && !Array.isArray(expand.enum)) {
        const asked = typeof args.expand === 'string' ? args.expand : '';
        whole.expand = /\bnames\b/.test(asked)
            ? asked
            : [asked, 'names'].filter(Boolean).join(',');
    }
    return whole;
}

/** A tool that returns many items: asked for all their fields, the answer would be huge. */
const MANY_ITEMS = /(list|search|query|find|all|batch)/i;

/**
 * A server that marks its tools (Linear, Rovo) offers only those it marks
 * read-only; one that doesn't, those no name or hint says write.
 */
function readOnlyTools(tools: MCPToolRaw[]): MCPToolRaw[] {
    const marked = tools.some(
        (t) => typeof asRecord(t.annotations).readOnlyHint === 'boolean',
    );
    return tools.filter(
        (t) =>
            isReadOnly(t) &&
            (!marked || asRecord(t.annotations).readOnlyHint === true),
    );
}

/**
 * The task, when `payload` holds a record that is exactly it; `complete`
 * when the record carries its description, even an empty one.
 */
function acceptedTask(
    payload: unknown,
    reference: TaskReference,
    repository?: { owner?: string; name: string },
): { task: Omit<Task, 'tracker'>; complete: boolean } | undefined {
    const record = recordWithId(payload, reference.id);
    if (!record || record.pull_request) {
        return undefined;
    }
    if (reference.kind === 'git_issue') {
        // `12` is also some Jira issue's internal id: only the repository's own issue counts.
        const repo = reference.repository ?? repository;
        const url = textField(record, ['html_url', 'web_url', 'url']) ?? '';
        if (
            !repo ||
            !url.toLowerCase().includes(`/${repo.name.toLowerCase()}/`)
        ) {
            return undefined;
        }
    }
    const described = describeTask(record);
    return described
        ? {
              task: { id: taskId(reference), ...described },
              complete: !!described.description || carriesDescription(record),
          }
        : undefined;
}

function clip(result: unknown): string {
    const text =
        typeof result === 'string' ? result : JSON.stringify(result ?? null);
    return text.length > MAX_OUTPUT_CHARS
        ? `${text.slice(0, MAX_OUTPUT_CHARS)}… (cut)`
        : text;
}
