export type CommandMode = 'human' | 'agent';

export type CommandErrorCode =
    | 'INVALID_INPUT'
    | 'AUTH_REQUIRED'
    | 'NOT_IN_GIT_REPO'
    | 'NO_CHANGES'
    | 'API_REQUEST_FAILED'
    | 'INTERNAL_ERROR';

export interface AgentErrorPayload {
    code: CommandErrorCode;
    message: string;
    details?: Record<string, unknown>;
}

export interface AgentEnvelopeMeta {
    schemaVersion: '1.0';
    cliVersion: string;
    mode: 'agent';
    durationMs: number;
}

export interface AgentSuccessEnvelope<T> {
    ok: true;
    command: string;
    data: T;
    error: null;
    meta: AgentEnvelopeMeta;
}

export interface AgentErrorEnvelope {
    ok: false;
    command: string;
    data: null;
    error: AgentErrorPayload;
    meta: AgentEnvelopeMeta;
}

export type AgentEnvelope<T> = AgentSuccessEnvelope<T> | AgentErrorEnvelope;
