import { PR_ADMISSION_STORE, type PrAdmissionStore, type RunDeliveryContext } from '../../shared/admission/pr-admission-store';
import { MessageHandlerErrorBehavior, Nack, RabbitPayload, RabbitRequest, RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';

import { WORKFLOW_JOB_QUEUE_ARGUMENTS } from '@libs/core/workflow/infrastructure/workflow-queue-arguments';
import { RUNTIME_CONTROL_BINDING, RUNTIME_CONTROL_QUEUE, RUNTIME_EXCHANGE, RUNTIME_RUN_BINDING, RUNTIME_RUN_QUEUE, RuntimeEventName, RunProjectionStore } from '@libs/runtime/run';

import { COMMAND_STORE, RUNTIME_CONFIG, type WorkerConfig } from '../../shared/config';
import { DistributedLocks, InMemoryDistributedLocks } from '../../shared/persistence/locks';
import type { CommandStore } from '../../shared/persistence/pg-command-store';
import {
    CellRevokeRequestedHandler,
    CellTokenIssuedHandler,
    CommandHandler,
    EgressApprovedHandler,
    LessonUpdateRequestedHandler,
    EnvironmentPoolRequestedHandler,
    type PoolTargetSender,
    type EgressPolicyPusher,
    EnvironmentSetupRequestedHandler,
    ForkApprovedHandler,
    StopClearedHandler,
    StopRequestedHandler,
} from '../commands/command-handlers';
import type { RunEngine } from '../commands/run-engine.port';
import { RunCancelRequestedHandler, RunRequestedHandler } from '../commands/run-requested.handler';
import { RunEngineService } from '../dbos/run-engine.service';
import { SealedSecretOpener, SECRET_OPENER } from '../secrets/sealed-tokens';
import { ENVIRONMENT_SETUP_STORE, type EnvironmentSetupStore } from '../setup/environment-setup.store';
import { LESSON_STORE, type LessonStore } from '../setup/lesson.store';
import { RuntimeCommandName } from '@libs/runtime/contracts/runtime-commands';
import { RUNTIME_RUN_ROUTING_KEY } from '@libs/runtime/run/run-messages';
import { deserializeRuntimeCommand, RuntimeRunRetry, runtimeRunErrorHandler } from './runtime-run-retry';

export type { EgressPolicyPusher } from '../commands/command-handlers';

// Consumes workflow.jobs.runtime_run.queue: an OutboxMessage without a job,
// with the full payload. No WorkflowJobConsumer and no product inbox: the
// DBOS workflowID (= runId) is the idempotency, and the ack only happens after
// the workflow is durably enqueued (§4, §7). This class only routes: each
// event has its own handler (worker/commands).

type Envelope = { event_name?: string; payload?: Record<string, unknown> } & Record<string, unknown>;

function unwrap(input: unknown): { event: string; body: Record<string, unknown> } | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const msg = input as Envelope;
    const event = Object.hasOwn(msg, 'event_name') ? msg.event_name : RuntimeEventName.RunRequested;
    if (typeof event !== 'string') return undefined;
    const body = msg.payload ?? msg;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
    const { workflowType: _wt, ...rest } = body;
    return { event, body: rest };
}

const RUN_EVENTS = new Set<string>([RuntimeEventName.RunRequested, RuntimeEventName.RunCancelRequested, RuntimeCommandName.EnvironmentSetupRequested]);

export const EGRESS_POLICY_PUSHER = Symbol('EGRESS_POLICY_PUSHER');
export const POOL_TARGET_SENDER = Symbol('POOL_TARGET_SENDER');
export const CONSUMER_LOCKS = Symbol('CONSUMER_LOCKS');

@Injectable()
export class RuntimeCommandConsumer {
    private readonly logger = new Logger('RuntimeCommandConsumer');
    private readonly handlers: Map<string, CommandHandler>;

    constructor(
        @Inject(RunEngineService) engine: RunEngine,
        @Inject('RUN_PROJECTION') projection: RunProjectionStore,
        @Inject(COMMAND_STORE) commands: CommandStore,
        @Inject(PR_ADMISSION_STORE) admissions: PrAdmissionStore,
        @Optional() @Inject(EGRESS_POLICY_PUSHER) egress?: EgressPolicyPusher,
        @Optional() @Inject(ENVIRONMENT_SETUP_STORE) setups?: Pick<EnvironmentSetupStore, 'get'>,
        @Optional() @Inject(CONSUMER_LOCKS) locks: DistributedLocks = new InMemoryDistributedLocks(),
        @Optional() @Inject(SECRET_OPENER) sealer?: SealedSecretOpener,
        @Optional() @Inject(POOL_TARGET_SENDER) pool?: PoolTargetSender,
        @Optional() @Inject(LESSON_STORE) lessons?: Pick<LessonStore, 'update'>,
        @Optional() @Inject(RUNTIME_CONFIG) config?: Pick<WorkerConfig, 'setup'>,
        @Optional() @Inject(RuntimeRunRetry) private readonly retry?: RuntimeRunRetry,
    ) {
        const all: CommandHandler[] = [
            new RunRequestedHandler(engine, projection, commands, locks, admissions, setups, { healthPath: config?.setup.healthPath }),
            new RunCancelRequestedHandler(engine, projection, locks, admissions),
            new ForkApprovedHandler(projection, commands, engine),
            new EgressApprovedHandler(commands, egress),
            new StopRequestedHandler(projection, commands, engine),
            new StopClearedHandler(commands),
            new EnvironmentSetupRequestedHandler(engine, sealer),
            new EnvironmentPoolRequestedHandler(setups, pool),
            new CellTokenIssuedHandler(commands),
            new CellRevokeRequestedHandler(commands),
            new LessonUpdateRequestedHandler(lessons),
        ];
        this.handlers = new Map(all.map((h) => [h.event, h]));
    }

    @RabbitSubscribe({
        exchange: RUNTIME_EXCHANGE,
        routingKey: RUNTIME_RUN_BINDING,
        queue: RUNTIME_RUN_QUEUE,
        errorBehavior: MessageHandlerErrorBehavior.NACK,
        errorHandler: runtimeRunErrorHandler,
        deserializer: deserializeRuntimeCommand,
        queueOptions: { channel: 'channel-runtime-run', arguments: WORKFLOW_JOB_QUEUE_ARGUMENTS[RUNTIME_RUN_QUEUE] },
    })
    async onMessage(@RabbitPayload() msg: unknown, @RabbitRequest() raw?: ConsumeMessage) {
        const parsed = unwrap(msg);
        if (!parsed || !RUN_EVENTS.has(parsed.event)) return this.reject('invalid_run_lane');
        if (raw && raw.fields.routingKey !== RUNTIME_RUN_ROUTING_KEY) return this.reject('invalid_run_route');
        if (this.retry && !this.retry.validCounter(raw)) return this.reject('invalid_retry_counter');
        try { return await this.handle(msg, {
            ...(typeof raw?.properties.messageId === 'string' && raw.properties.messageId.length > 0 && raw.properties.messageId.length <= 256 ? { messageId: raw.properties.messageId } : {}),
            redelivered: raw?.fields.redelivered === true || (typeof raw?.properties.headers?.['x-retry-count'] === 'number' && raw.properties.headers['x-retry-count'] > 0),
        }); }
        catch (error) {
            if ((error as { code?: unknown } | null)?.code === 'admission_conflict') return this.reject('admission_conflict');
            if (this.retry) throw this.retry.failure();
            return this.reject('dispatch_unavailable');
        }
    }

    /** Stop, revoke, approvals and pool: their own queue and channel, never behind Run requests. */
    @RabbitSubscribe({
        exchange: RUNTIME_EXCHANGE,
        routingKey: RUNTIME_CONTROL_BINDING,
        queue: RUNTIME_CONTROL_QUEUE,
        errorBehavior: MessageHandlerErrorBehavior.NACK,
        deserializer: deserializeRuntimeCommand,
        queueOptions: { channel: 'channel-runtime-control', arguments: WORKFLOW_JOB_QUEUE_ARGUMENTS[RUNTIME_CONTROL_QUEUE] },
    })
    async onControl(msg: unknown) {
        const parsed = unwrap(msg);
        if (!parsed || RUN_EVENTS.has(parsed.event)) return this.reject('invalid_control_lane');
        try { return await this.handle(msg); }
        catch { return this.reject('control_dispatch_unavailable'); }
    }

    async handle(msg: unknown, delivery?: RunDeliveryContext): Promise<void | Nack> {
        const parsed = unwrap(msg);
        if (!parsed) return this.reject('invalid_envelope');
        const { event, body } = parsed;
        const handler = this.handlers.get(event);
        if (!handler) return this.reject('unknown_event');
        const out = await handler.handle(body, delivery);
        if (out && 'invalid' in out) return this.reject('invalid_command');
    }

    private reject(reason: string) {
        this.logger.error({ msg: 'message.dead_lettered', reason });
        return new Nack(false);
    }
}

/** @deprecated the old name: it consumes every Runtime command, not only Run requests. */
export const RunRequestConsumer = RuntimeCommandConsumer;
