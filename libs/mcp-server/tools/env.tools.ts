import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { createLogger } from '@libs/core/log/logger';
import { RuntimeEnvToolsService } from '@libs/runtime/api/application/env-tools.service';
import type { EnvKeyPrincipal } from '@libs/runtime/api/domain/env-tools';
import {
    RUNTIME_RELEASE_GATE,
    type RuntimeReleaseGate,
} from '@libs/runtime/api/domain/ports';

import { getMcpPrincipal } from '../auth/mcp-principal';
import type { McpToolAnnotations } from '../types/mcp-tool.interface';

// The env_* tools of /mcp/env (§4 "MCP e CLI", §7, Inc. 1). The credential is
// the only source of org, team, key and repo list; the arguments only name
// an environment, a session or a step. Capability, repo and tenant checks live
// in RuntimeEnvToolsService, so the CLI and this endpoint share one rule.

const target = {
    environmentId: z
        .string()
        .max(128)
        .optional()
        .describe(
            'The Kody Runtime environment id. Optional when the key reaches a single environment.',
        ),
    repositoryId: z
        .string()
        .max(128)
        .optional()
        .describe('Alternatively, the repository id whose environment to use.'),
};

export interface EnvToolDefinition {
    name: string;
    description: string;
    inputSchema: z.ZodRawShape;
    annotations: McpToolAnnotations;
    run: (
        service: RuntimeEnvToolsService,
        principal: EnvKeyPrincipal,
        args: Record<string, unknown>,
    ) => Promise<unknown>;
}

export const ENV_TOOLS: EnvToolDefinition[] = [
    {
        name: 'env_up',
        description:
            'Open a Kody Runtime environment of the repository (the default branch recipe) at a commit, the default branch head unless `sha` is given. An environment of several repositories boots all of them, each at its default branch head unless `commits` names one, laid out as ws/<alias>; the session lists them in `repositories`. Answers the session: `ready` with its services, `blocked` with the blockers (then use env_blockers), or `acquiring` — call env_up again with the `sessionId` until it settles. Needs env:exec.',
        inputSchema: {
            ...target,
            sha: z
                .string()
                .max(40)
                .optional()
                .describe('Full 40-character commit SHA to check out.'),
            commits: z
                .record(z.string().max(63), z.string().max(40))
                .optional()
                .describe('Several repositories: the full commit SHA to check out per repository alias, e.g. {"billing": "<sha>"}.'),
            sessionId: z
                .string()
                .max(128)
                .optional()
                .describe('Read an existing session instead of opening one.'),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        },
        run: (s, p, a) => s.up(p, a),
    },
    {
        name: 'env_exec',
        description:
            'Run a shell command inside the environment of a ready session. Does not wait: answers a `stepId` at once; read the result with env_step. Every call is audited and limited per key and per organization. Needs env:exec.',
        inputSchema: {
            sessionId: z.string().max(128),
            command: z
                .string()
                .max(8_192)
                .describe('The command, run in the app container.'),
            cwd: z.string().max(1_024).optional(),
            repository: z
                .string()
                .max(63)
                .optional()
                .describe("Several repositories: the alias of the repository whose directory the command runs in; the primary's by default."),
            timeoutMs: z
                .number()
                .int()
                .optional()
                .describe('Between 1000 and 600000; 120000 by default.'),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
        },
        run: (s, p, a) => s.exec(p, a),
    },
    {
        name: 'env_upload',
        description:
            "Write files into the checkout of a ready session (fixtures, seed data, a config the app reads): at most 32 files and 512 KiB together per call, each a path relative to the checkout and its bytes in base64. Answers once every file is written, with its size and sha256. Not into .git or the Runtime's own .kodus files. Audited and counted with env_exec in its hourly limit. Needs env:exec.",
        inputSchema: {
            sessionId: z.string().max(128),
            files: z
                .array(
                    z.object({
                        path: z
                            .string()
                            .max(1_024)
                            .describe('Relative to the checkout, without . or .. segments, e.g. fixtures/users.json.'),
                        contentBase64: z.string().describe("The file's bytes, base64."),
                        mode: z
                            .number()
                            .int()
                            .optional()
                            .describe('Unix permission bits, e.g. 493 (0755) for a script; 0644 by default.'),
                    }),
                )
                .max(32),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
        },
        run: (s, p, a) => s.upload(p, a),
    },
    {
        name: 'env_validate',
        description:
            'Run one named check from the default-branch recipe pinned when this session opened. Explicit internal workload validation, never regression proof. Returns a stepId immediately; poll env_step. Uses the env_exec quota and audit. Needs env:exec and a supported isolated workload; accepts no command or cwd.',
        inputSchema: {
            sessionId: z.string().max(128),
            name: z.string().min(1).max(128),
            timeoutMs: z.number().int().optional(),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
        },
        run: (s, p, a) => s.validate(p, a),
    },
    {
        name: 'env_step',
        description:
            'The result of an env_exec step: `running`, or `done` with exitCode, stdout and stderr (secrets redacted), or `lost`. Needs env:exec.',
        inputSchema: { stepId: z.string().max(128) },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
        run: (s, p, a) => s.step(p, a),
    },
    {
        name: 'env_blockers',
        description:
            "Why the environment does not boot: each blocker with its evidence and the catalog's fixes, the recommended one first (what worked before in this repo comes first). Needs env:exec or env:fix.",
        inputSchema: target,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
        run: (s, p, a) => s.blockers(p, a),
    },
    {
        name: 'env_status',
        description:
            "The environment's health without booting it: `state` (setting_up, active, blocked or not_set_up), the last 7 days of setup boots (`boots7d`, `bootRate7d`, `readyP50Ms`), the current `imageId` and `cellId`, the `setupKey` of the setup it reads, and the blockers grouped by signature with how often each failed this week (env_blockers has their evidence and fixes). Needs env:exec or env:fix.",
        inputSchema: target,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
        run: (s, p, a) => s.status(p, a),
    },
    {
        name: 'env_fix',
        description:
            'Apply one fix env_blockers offers, by its blocker `signature` and `fixId`: a recipe fix opens a pull request with the one-field change, "set up again" asks for a new setup. Approving an egress host is left to an org admin. Needs env:fix.',
        inputSchema: {
            ...target,
            signature: z.string().max(512),
            fixId: z.string().max(300),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        },
        run: (s, p, a) => s.fix(p, a),
    },
    {
        name: 'env_recipe_check',
        description:
            "Check a recipe the developer's agent wrote (.kodus/workspace.yaml and its .kodus/ build files) the way Kodus checks one before it boots: `ok`, each error to fix, and what Kodus read from it (public service, health path, exposed services). Nothing is kept and nothing boots. Needs env:exec or env:fix.",
        inputSchema: {
            ...target,
            recipe: z.string().max(65_536).describe('The recipe text, version 1.'),
            files: z
                .array(z.object({ path: z.string().max(80).describe('Directly under .kodus/, e.g. .kodus/Dockerfile.'), content: z.string().max(16_384) }))
                .max(4)
                .optional()
                .describe('The build files the recipe names that the repository lacks: at most 4, 16 KiB each, 48 KiB together.'),
        },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
        run: (s, p, a) => s.checkRecipe(p, a),
    },
    {
        name: 'env_recipe_submit',
        description:
            "Send the recipe the developer's agent wrote: Kodus keeps it for the environment and sets it up from zero on a clean machine. It boots while the default branch has no recipe (a committed one always wins); Kody never rewrites it. Answers the `setupKey`: follow with env_status until its `setupKey` is this one and its state is `active` or `blocked`; when blocked, env_blockers has the evidence to fix it and send again. Once it boots, commit it in a pull request. Needs env:fix.",
        inputSchema: {
            ...target,
            recipe: z.string().max(65_536).describe('The recipe text, version 1.'),
            files: z
                .array(z.object({ path: z.string().max(80), content: z.string().max(16_384) }))
                .max(4)
                .optional()
                .describe('The build files the recipe names that the repository lacks, directly under .kodus/.'),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        },
        run: (s, p, a) => s.submitRecipe(p, a),
    },
    {
        name: 'env_down',
        description:
            'Release the session and its machines. Sessions idle for 10 minutes are released on their own. Needs env:exec.',
        inputSchema: { sessionId: z.string().max(128) },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
        },
        run: (s, p, a) => s.down(p, a),
    },
];

/** A tool error the agent can act on: the HTTP status, a code and our own message (never a stack or a platform error). */
export function envToolError(e: unknown): CallToolResult {
    let status = 500;
    let code = 'internal_error';
    let message = 'The tool failed.';
    if (e instanceof HttpException) {
        status = e.getStatus();
        const body = e.getResponse() as
            string | { code?: unknown; message?: unknown };
        code =
            typeof body === 'object' && typeof body.code === 'string'
                ? body.code
                : ((
                      {
                          400: 'invalid_arguments',
                          401: 'unauthorized',
                          403: 'forbidden',
                          404: 'not_found',
                          409: 'conflict',
                          429: 'rate_limited',
                          503: 'unavailable',
                      } as Record<number, string>
                  )[status] ?? 'error');
        message =
            typeof body === 'object' && body.message !== undefined
                ? String(
                      Array.isArray(body.message)
                          ? body.message.join('; ')
                          : body.message,
                  )
                : e.message;
    }
    const payload = { status, code, message };
    return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError: true,
    };
}

/** The principal of a team key, or null for any other credential (S-45: chat and service credentials never reach env_*). */
export function envPrincipalOf(extra: unknown): EnvKeyPrincipal | null {
    const p = getMcpPrincipal(extra);
    if (!p || p.kind !== 'team-key' || !p.keyId) return null;
    return {
        keyId: p.keyId,
        organizationId: p.organizationId,
        teamId: p.teamId,
        capabilities: p.config?.capabilities ?? [],
        repositoryIds: p.config?.repositoryIds ?? [],
    };
}

@Injectable()
export class EnvTools {
    private readonly logger = createLogger(EnvTools.name);

    constructor(
        private readonly service: RuntimeEnvToolsService,
        @Inject(RUNTIME_RELEASE_GATE)
        private readonly release: RuntimeReleaseGate,
    ) {}

    async call(
        tool: EnvToolDefinition,
        args: Record<string, unknown>,
        extra: unknown,
    ): Promise<CallToolResult> {
        const principal = envPrincipalOf(extra);
        if (!principal) {
            return envToolError(
                new HttpException(
                    {
                        code: 'team_key_required',
                        message: 'The env_* tools take a team API key only.',
                    },
                    401,
                ),
            );
        }
        // Kody Runtime is an alpha in the feature catalog: an org it is not released to gets no environment.
        if (!(await this.release.isEnabledFor(principal.organizationId))) {
            return envToolError(
                new HttpException(
                    {
                        code: 'not_available',
                        message:
                            'Kody Runtime is not available for this organization.',
                    },
                    404,
                ),
            );
        }
        try {
            const data = (await tool.run(
                this.service,
                principal,
                args ?? {},
            )) as Record<string, unknown>;
            return {
                content: [{ type: 'text', text: JSON.stringify(data) }],
                structuredContent: data,
            };
        } catch (e) {
            if (!(e instanceof HttpException)) {
                // Ids and kinds only: a command or a token never goes to the log.
                this.logger.error({
                    message: 'MCP env tool failed',
                    context: EnvTools.name,
                    error: e instanceof Error ? e : undefined,
                    metadata: {
                        tool: tool.name,
                        organizationId: principal.organizationId,
                        keyId: principal.keyId,
                    },
                });
            }
            return envToolError(e);
        }
    }
}
