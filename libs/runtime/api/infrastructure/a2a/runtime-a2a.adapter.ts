import {
    AgentCard,
    Role,
    Task,
    TaskState,
    type SendMessageRequest,
} from '@a2a-js/sdk';
import {
    JsonRpcPushNotificationNotSupportedError,
    JsonRpcRequestMalformedError,
    JsonRpcTaskNotCancelableError,
    JsonRpcTaskNotFoundError,
    JsonRpcTransportError,
    JsonRpcUnsupportedOperationError,
    JsonRpcVersionNotSupportedError,
    toJsonRpcError,
} from '@a2a-js/sdk/errors';
import {
    JsonRpcTransportHandler,
    ServerCallContext,
    type A2ARequestHandler,
} from '@a2a-js/sdk/server';
import {
    HttpException,
    Inject,
    Injectable,
    Logger,
    ServiceUnavailableException,
} from '@nestjs/common';

import type { EnvKeyPrincipal } from '../../domain/env-tools';
import {
    RUNTIME_EXTERNAL_FINDINGS,
    type ExternalFindingsPort,
    type ExternalTaskView,
} from '../../domain/external-findings';
import { checkedA2AWire } from './runtime-a2a.validation';

export const RUNTIME_A2A_BASE_URL = Symbol.for('RuntimeApi.A2ABaseUrl');
const PRINCIPAL = 'runtime.external.principal';

const taskStates = {
    completed: TaskState.TASK_STATE_COMPLETED,
    working: TaskState.TASK_STATE_WORKING,
    failed: TaskState.TASK_STATE_FAILED,
    rejected: TaskState.TASK_STATE_REJECTED,
} as const;

/** The public wire is serialized by the official 1.0 SDK, never its legacy compatibility adapter. */
export function a2aTask(view: ExternalTaskView): Task {
    return Task.fromJSON({
        id: view.id,
        contextId: view.contextId,
        status: { state: taskStates[view.state], timestamp: view.updatedAt },
        artifacts: [
            {
                artifactId: `${view.id}:result`,
                name: 'Finding verification',
                parts: [{ data: view.result, mediaType: 'application/json' }],
            },
        ],
    });
}

/** Only a configured origin can advertise an interface; request Host headers are never authority. */
function configuredEndpoint(base: string | undefined): string {
    try {
        if (!base) throw new Error();
        const url = new URL(base);
        const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
        if (
            (url.protocol !== 'https:' &&
                !(url.protocol === 'http:' && loopback)) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            url.pathname !== '/'
        )
            throw new Error();
        return new URL('/runtime/a2a', url).toString();
    } catch {
        throw new ServiceUnavailableException(
            'Runtime A2A origin is not configured',
        );
    }
}

function fixedError(error: unknown): Error {
    const status = error instanceof HttpException ? error.getStatus() : 500;
    if (status === 404) return new JsonRpcTaskNotFoundError();
    if (status === 400 || status === 409)
        return new JsonRpcRequestMalformedError({
            message: 'Finding request was refused',
        });
    if (status === 403)
        return new JsonRpcTransportError({
            jsonrpc: '2.0',
            id: null,
            error: { code: -31003, message: 'Finding access denied' },
        });
    if (status === 429)
        return new JsonRpcTransportError({
            jsonrpc: '2.0',
            id: null,
            error: { code: -31029, message: 'Finding quota reached' },
        });
    return new JsonRpcTransportError({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: 'Finding service unavailable' },
    });
}

function operationOf(
    body: unknown,
):
    | 'submit_findings'
    | 'verify_finding'
    | 'get_task'
    | 'cancel_task'
    | 'unsupported' {
    if (!body || typeof body !== 'object') return 'unsupported';
    const rpc = body as {
        method?: unknown;
        params?: {
            message?: { parts?: Array<{ data?: { operation?: unknown } }> };
        };
    };
    if (rpc.method === 'GetTask') return 'get_task';
    if (rpc.method === 'CancelTask') return 'cancel_task';
    if (rpc.method === 'SendMessage') {
        const operation = rpc.params?.message?.parts?.[0]?.data?.operation;
        if (operation === 'submit_findings' || operation === 'verify_finding')
            return operation;
    }
    return 'unsupported';
}

@Injectable()
export class RuntimeA2AAdapter {
    private readonly log = new Logger(RuntimeA2AAdapter.name);
    constructor(
        @Inject(RUNTIME_EXTERNAL_FINDINGS)
        private readonly findings: ExternalFindingsPort,
        @Inject(RUNTIME_A2A_BASE_URL)
        private readonly baseUrl: string | undefined,
    ) {}

    card(): AgentCard {
        return AgentCard.fromJSON({
            name: 'Kody Runtime finding verification',
            description:
                'Submit findings and independently replay executable probes on base and PR. Poll scoped verification tasks; submitted observations are untrusted.',
            version: '1.0.0',
            supportedInterfaces: [
                {
                    url: configuredEndpoint(this.baseUrl),
                    protocolBinding: 'JSONRPC',
                    protocolVersion: '1.0',
                },
            ],
            capabilities: {
                streaming: false,
                pushNotifications: false,
                extendedAgentCard: false,
            },
            securitySchemes: {
                teamKey: {
                    httpAuthSecurityScheme: {
                        scheme: 'Bearer',
                        bearerFormat: 'kodus team key',
                    },
                },
            },
            securityRequirements: [{ schemes: { teamKey: { list: [] } } }],
            defaultInputModes: ['application/json'],
            defaultOutputModes: ['application/json'],
            skills: [
                {
                    id: 'submit_findings',
                    name: 'Submit findings',
                    description:
                        'Receive a completed receipt with a separate durable verification task. Requires findings:submit and env:exec for executable probes.',
                    tags: ['findings', 'verification'],
                },
                {
                    id: 'verify_finding',
                    name: 'Verify a finding',
                    description:
                        'Read the linked verification task. Set configuration.returnImmediately:true and poll GetTask until terminal.',
                    tags: ['replay', 'verification'],
                },
            ],
        });
    }

    async rpc(
        principal: EnvKeyPrincipal,
        body: unknown,
        requestedVersion: string | undefined,
    ) {
        const started = performance.now();
        let outcome: 'accepted' | 'refused' | 'failed' = 'failed';
        try {
            const result = await this.execute(
                principal,
                body,
                requestedVersion,
            );
            const error = result.error as { code?: number } | undefined;
            outcome = !error
                ? 'accepted'
                : error.code === -32603
                  ? 'failed'
                  : 'refused';
            return result;
        } finally {
            this.log.log({
                msg: 'runtime.a2a.request',
                operation: operationOf(body),
                outcome,
                durationMs: Math.max(0, performance.now() - started),
                organizationId: principal.organizationId,
                keyId: principal.keyId,
            });
        }
    }

    private async execute(
        principal: EnvKeyPrincipal,
        body: unknown,
        requestedVersion: string | undefined,
    ) {
        const checked = checkedA2AWire(body);
        const id = 'rpc' in checked ? checked.rpc.id : null;
        const fail = (error: Error) => ({
            jsonrpc: '2.0',
            id,
            error: toJsonRpcError(error),
        });
        if (requestedVersion !== '1.0')
            return fail(new JsonRpcVersionNotSupportedError());
        if ('unsupportedPush' in checked)
            return fail(new JsonRpcPushNotificationNotSupportedError());
        if (!checked.ok)
            return fail(
                new JsonRpcRequestMalformedError({
                    message: 'A bounded structured finding request is required',
                }),
            );
        if (checked.rpc.method.includes('PushNotification'))
            return fail(new JsonRpcPushNotificationNotSupportedError());
        if (
            checked.rpc.method === 'SendStreamingMessage' ||
            checked.rpc.method === 'SubscribeToTask'
        )
            return fail(new JsonRpcUnsupportedOperationError());
        const invoke = async (operation: () => Promise<ExternalTaskView>) => {
            try {
                return a2aTask(await operation());
            } catch (error) {
                throw fixedError(error);
            }
        };
        const owner = (ctx: ServerCallContext): EnvKeyPrincipal =>
            ctx.state.get(PRINCIPAL) as EnvKeyPrincipal;
        const unsupported = async (): Promise<never> => {
            throw new JsonRpcUnsupportedOperationError();
        };
        const pushUnsupported = async (): Promise<never> => {
            throw new JsonRpcPushNotificationNotSupportedError();
        };
        const handler: A2ARequestHandler = {
            getAgentCard: async () => this.card(),
            getAuthenticatedExtendedAgentCard: unsupported,
            sendMessage: async (params: SendMessageRequest, ctx) => {
                if (
                    params.message?.role !== Role.ROLE_USER ||
                    !('operation' in checked) ||
                    !checked.operation
                )
                    throw new JsonRpcRequestMalformedError();
                return invoke(() =>
                    checked.operation === 'submit_findings'
                        ? this.findings.submit(
                              owner(ctx),
                              checked.input,
                              params.message!.messageId,
                          )
                        : this.findings.verify(
                              owner(ctx),
                              checked.input,
                              params.message!.messageId,
                          ),
                );
            },
            getTask: async (params, ctx) =>
                invoke(() => this.findings.getTask(owner(ctx), params.id)),
            cancelTask: async (params, ctx) => {
                await invoke(() =>
                    this.findings.getTask(owner(ctx), params.id),
                );
                throw new JsonRpcTaskNotCancelableError();
            },
            listTasks: unsupported,
            createTaskPushNotificationConfig: pushUnsupported,
            getTaskPushNotificationConfig: pushUnsupported,
            listTaskPushNotificationConfigs: pushUnsupported,
            deleteTaskPushNotificationConfig: pushUnsupported,
            sendMessageStream: async function* () {
                throw new JsonRpcUnsupportedOperationError();
            },
            resubscribe: async function* () {
                throw new JsonRpcUnsupportedOperationError();
            },
        };
        const context = new ServerCallContext({
            requestedVersion: '1.0',
            state: new Map([[PRINCIPAL, principal]]),
        });
        const result = await new JsonRpcTransportHandler(handler).handle(
            checked.rpc,
            context,
        );
        if (Symbol.asyncIterator in result)
            return fail(new JsonRpcUnsupportedOperationError());
        return result;
    }
}
