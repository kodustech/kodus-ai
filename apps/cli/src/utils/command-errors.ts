import { ApiError, AuthError } from '../types/errors.js';
import type {
    AgentErrorPayload,
    CommandErrorCode,
} from '../types/command-output.js';

function isMessageMatch(message: string, terms: string[]): boolean {
    const lower = message.toLowerCase();
    return terms.some((term) => lower.includes(term));
}

function getApiUnavailableMessage(error: Error): string | null {
    const cause = error as Error & { cause?: { code?: string } };
    const code = cause.cause?.code;

    if (
        !isMessageMatch(error.message, ['fetch failed', 'network', 'econnrefused']) &&
        !['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET'].includes(code ?? '')
    ) {
        return null;
    }

    const apiUrl = process.env.KODUS_API_URL?.trim() || 'the configured Kodus API';
    const localHint = apiUrl.includes('localhost') || apiUrl.includes('127.0.0.1')
        ? ' If you are using the local API, make sure it is running.'
        : '';

    return `Could not reach the Kodus API at ${apiUrl}.${localHint}`;
}

export class CommandError extends Error {
    constructor(
        public readonly code: CommandErrorCode,
        message: string,
        public readonly exitCode: number = 1,
        public readonly details?: Record<string, unknown>,
    ) {
        super(message);
        this.name = 'CommandError';
    }
}

export interface NormalizedCommandError extends AgentErrorPayload {
    exitCode: number;
}

export function normalizeCommandError(error: unknown): NormalizedCommandError {
    if (error instanceof CommandError) {
        return {
            code: error.code,
            message: error.message,
            details: error.details,
            exitCode: error.exitCode,
        };
    }

    if (error instanceof AuthError) {
        return {
            code: 'AUTH_REQUIRED',
            message: error.message,
            exitCode: 1,
        };
    }

    if (error instanceof ApiError) {
        return {
            code: 'API_REQUEST_FAILED',
            message: error.message,
            details: { statusCode: error.statusCode },
            exitCode: 1,
        };
    }

    if (error instanceof Error) {
        const apiUnavailableMessage = getApiUnavailableMessage(error);
        if (apiUnavailableMessage) {
            return {
                code: 'API_REQUEST_FAILED',
                message: apiUnavailableMessage,
                exitCode: 1,
            };
        }

        if (
            isMessageMatch(error.message, [
                'not a git repository',
                'run inside a git repo',
            ])
        ) {
            return {
                code: 'NOT_IN_GIT_REPO',
                message: error.message,
                exitCode: 1,
            };
        }

        if (
            isMessageMatch(error.message, [
                'no changes to review',
                'no local changes found',
                'no local diff scope provided',
            ])
        ) {
            return {
                code: 'NO_CHANGES',
                message: error.message,
                exitCode: 0,
            };
        }

        if (
            isMessageMatch(error.message, [
                'invalid --',
                'invalid value for `--',
                'provide --',
                'choose a mode:',
                'cannot be used with',
                'cannot be used together',
                'use one of:',
            ])
        ) {
            return {
                code: 'INVALID_INPUT',
                message: error.message,
                exitCode: 1,
            };
        }

        return {
            code: 'INTERNAL_ERROR',
            message: error.message,
            exitCode: 1,
        };
    }

    return {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        exitCode: 1,
    };
}
