import type {
    EnvBlockerGroup,
    EnvFixResult,
    EnvHealth,
    EnvRecipeCheck,
    EnvRecipeInput,
    EnvRecipeSubmit,
    EnvStatus,
    EnvTarget,
} from '../types/env.js';
import { CommandError } from '../utils/command-errors.js';
import { resolveTeamKeyAccess } from '../utils/team-key-auth.js';
import { request } from './api/api-core.js';

const ENV_AUTH_MESSAGE =
    'Kody Runtime environment commands require team-key auth with env:exec or env:fix. Run: kodus auth team-key --key <your-key>.\nGet your key from: https://app.kodus.io/organization/cli-keys';

type Requester = <T>(endpoint: string, options?: RequestInit) => Promise<T>;

type ToolResult = {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type: string; text?: string }>;
};

type JsonRpcResponse = {
    result?: ToolResult;
    error?: { code: number; message: string };
};

/**
 * `kodus env` talks to the same /mcp/env tools the dev's agent uses, so the
 * key's capability and repository checks are the same in both.
 */
export class EnvService {
    constructor(private readonly requester: Requester = request) {}

    async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
        const { teamKey } = await resolveTeamKeyAccess(ENV_AUTH_MESSAGE);
        const response = await this.requester<JsonRpcResponse>('/mcp/env', {
            method: 'POST',
            headers: {
                'X-Team-Key': teamKey,
                'Accept': 'application/json, text/event-stream',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name, arguments: args },
            }),
        });
        if (response?.error) {
            throw new CommandError(
                'API_REQUEST_FAILED',
                response.error.message || 'The Kodus API refused the call.',
            );
        }
        const result = response?.result;
        const data =
            result?.structuredContent ??
            parseText(result?.content?.[0]?.text) ??
            {};
        if (result?.isError) {
            throw toolError(data);
        }
        return data as T;
    }

    status(target: EnvTarget): Promise<EnvStatus> {
        return this.callTool<EnvStatus>('env_blockers', compact(target));
    }

    /** The blocker to fix: the one named, or the only one. */
    pickBlocker(status: EnvStatus, signature?: string): EnvBlockerGroup {
        if (signature) {
            const found = status.blockers.find(
                (b) => b.signature === signature,
            );
            if (!found) {
                throw new CommandError(
                    'INVALID_INPUT',
                    `No blocker "${signature}" on this environment. Run: kodus env status`,
                );
            }
            return found;
        }
        if (status.blockers.length === 1) {
            return status.blockers[0];
        }
        throw new CommandError(
            'INVALID_INPUT',
            status.blockers.length
                ? 'This environment has more than one blocker; name it: kodus env fix <signature>. Run: kodus env status'
                : 'This environment has no blocker to fix.',
        );
    }

    fix(
        target: EnvTarget & { signature: string; fixId: string },
    ): Promise<EnvFixResult> {
        return this.callTool<EnvFixResult>('env_fix', compact(target));
    }

    /** env_status: the state and which setup it reads (setupKey). */
    health(target: EnvTarget): Promise<EnvHealth> {
        return this.callTool<EnvHealth>('env_status', compact(target));
    }

    /** env_recipe_check: what Kodus would refuse in the recipe; keeps nothing. */
    checkRecipe(input: EnvRecipeInput): Promise<EnvRecipeCheck> {
        return this.callTool<EnvRecipeCheck>(
            'env_recipe_check',
            recipeArgs(input),
        );
    }

    /** env_recipe_submit: Kodus keeps the recipe and sets the environment up from it. */
    submitRecipe(input: EnvRecipeInput): Promise<EnvRecipeSubmit> {
        return this.callTool<EnvRecipeSubmit>(
            'env_recipe_submit',
            recipeArgs(input),
        );
    }
}

const recipeArgs = (input: EnvRecipeInput) => ({
    ...compact({
        environmentId: input.environmentId,
        repositoryId: input.repositoryId,
    }),
    recipe: input.recipe,
    ...(input.files?.length ? { files: input.files } : {}),
});

const compact = (o: Record<string, unknown>) =>
    Object.fromEntries(
        Object.entries(o).filter(([, v]) => v !== undefined && v !== ''),
    );

function parseText(text?: string): Record<string, unknown> | undefined {
    if (!text) {
        return undefined;
    }
    try {
        return JSON.parse(text);
    } catch {
        return { message: text };
    }
}

function toolError(data: Record<string, unknown>): CommandError {
    const status = Number(data.status);
    const message =
        typeof data.message === 'string' ? data.message : 'The tool failed.';
    if (status === 401) {
        return new CommandError('AUTH_REQUIRED', ENV_AUTH_MESSAGE);
    }
    if (status === 400) {
        return new CommandError('INVALID_INPUT', message);
    }
    if (status === 403) {
        return new CommandError(
            'AUTH_REQUIRED',
            `${message}. Turn the capability on for this key in Organization → CLI keys.`,
        );
    }
    if (status === 404) {
        return new CommandError(
            'INVALID_INPUT',
            `${message}. The key reaches only the repositories listed on it.`,
        );
    }
    return new CommandError('API_REQUEST_FAILED', message, 1, {
        status,
        code: data.code,
    });
}

export const envService = new EnvService();
