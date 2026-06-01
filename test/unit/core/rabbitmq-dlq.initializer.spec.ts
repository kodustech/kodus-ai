import { RabbitMQDLQInitializer } from "@libs/core/infrastructure/queue/rabbitmq-dlq.initializer";

/**
 * Guards against the race-condition fix in rabbitmq-dlq.initializer.ts:
 * - Must implement `onApplicationBootstrap` (runs AFTER every module's
 *   onModuleInit, so the @RabbitSubscribe consumers have already
 *   declared workflow.jobs.*.queue).
 * - Must NOT implement `onModuleInit` (used to, which caused bind
 *   attempts on queues that didn't exist yet — silently dropping
 *   delayed retries on first boot with a fresh rabbit volume).
 */

describe("RabbitMQDLQInitializer lifecycle", () => {
    it("implements onApplicationBootstrap", () => {
        const instance = new RabbitMQDLQInitializer();
        expect(typeof instance.onApplicationBootstrap).toBe("function");
    });

    it("does NOT implement onModuleInit (moved on purpose)", () => {
        const instance = new RabbitMQDLQInitializer() as unknown as Record<
            string,
            unknown
        >;
        expect(instance.onModuleInit).toBeUndefined();
    });

    it("skips setup gracefully when amqpConnection is missing", async () => {
        const instance = new RabbitMQDLQInitializer();
        await expect(instance.onApplicationBootstrap()).resolves.toBeUndefined();
    });

    it("asserts delayed exchanges and bind queues when a live channel exists", async () => {
        const assertExchange = jest.fn().mockResolvedValue(undefined);
        const bindQueue = jest.fn().mockResolvedValue(undefined);
        const assertQueue = jest.fn().mockResolvedValue(undefined);
        const addSetup = jest
            .fn()
            .mockImplementation(async (cb: (ch: unknown) => Promise<void>) => {
                // addSetup also triggers the full declare path
                await cb({ assertExchange, bindQueue, assertQueue });
            });

        const amqp = {
            channel: { assertExchange, bindQueue },
            managedChannel: { addSetup },
        } as any;

        const instance = new RabbitMQDLQInitializer(amqp);
        await instance.onApplicationBootstrap();

        // 3 delayed exchanges declared eagerly
        expect(assertExchange).toHaveBeenCalledWith(
            "workflow.exchange.delayed",
            "x-delayed-message",
            expect.any(Object),
        );
        expect(assertExchange).toHaveBeenCalledWith(
            "workflow.events.delayed",
            "x-delayed-message",
            expect.any(Object),
        );
        expect(assertExchange).toHaveBeenCalledWith(
            "orchestrator.exchange.delayed",
            "x-delayed-message",
            expect.any(Object),
        );

        // 5 workflow queues bound to workflow.exchange.delayed
        const expectedQueues = [
            "workflow.jobs.code_review.queue",
            "workflow.jobs.webhook.queue",
            "workflow.jobs.check_implementation.queue",
            "workflow.jobs.ast_graph_build.queue",
            "workflow.jobs.ast_graph_incremental.queue",
        ];
        for (const q of expectedQueues) {
            expect(bindQueue).toHaveBeenCalledWith(
                q,
                "workflow.exchange.delayed",
                expect.stringMatching(/workflow\.jobs\.\*/),
            );
        }

        // addSetup registered for reconnection path
        expect(addSetup).toHaveBeenCalledTimes(1);
    });

    it("does not assertQueue for workflow.jobs.*.queue (they come from @RabbitSubscribe)", async () => {
        const assertExchange = jest.fn().mockResolvedValue(undefined);
        const bindQueue = jest.fn().mockResolvedValue(undefined);
        const assertQueue = jest.fn().mockResolvedValue(undefined);
        const addSetup = jest.fn();
        const amqp = {
            channel: { assertExchange, bindQueue },
            managedChannel: { addSetup },
        } as any;

        const instance = new RabbitMQDLQInitializer(amqp);
        await instance.onApplicationBootstrap();

        const assertedQueues = assertQueue.mock.calls.map((c) => c[0]);
        expect(assertedQueues).not.toContain(
            "workflow.jobs.code_review.queue",
        );
        expect(assertedQueues).not.toContain("workflow.jobs.webhook.queue");
    });

    // Regression: `this.amqpConnection.channel` is a getter that throws
    // ChannelNotAvailableError when the RabbitMQ handshake hasn't
    // completed at bootstrap. That exception used to propagate out of
    // onApplicationBootstrap and crash the entire Nest process. Now it
    // must be tolerated — the addSetup callback below handles the
    // reconnection path.
    it("tolerates the .channel getter throwing, still registers addSetup", async () => {
        const addSetup = jest.fn();
        const amqp = {
            get channel() {
                const err: any = new Error("channel is not available");
                err.name = "ChannelNotAvailableError";
                throw err;
            },
            managedChannel: { addSetup },
        } as any;

        const instance = new RabbitMQDLQInitializer(amqp);
        await expect(
            instance.onApplicationBootstrap(),
        ).resolves.toBeUndefined();
        expect(addSetup).toHaveBeenCalledTimes(1);
    });

    it("tolerates .channel being null, still registers addSetup", async () => {
        const addSetup = jest.fn();
        const amqp = {
            channel: null,
            managedChannel: { addSetup },
        } as any;

        const instance = new RabbitMQDLQInitializer(amqp);
        await expect(
            instance.onApplicationBootstrap(),
        ).resolves.toBeUndefined();
        expect(addSetup).toHaveBeenCalledTimes(1);
    });

    it("skips gracefully when managedChannel is missing", async () => {
        const amqp = { channel: {}, managedChannel: undefined } as any;
        const instance = new RabbitMQDLQInitializer(amqp);
        await expect(
            instance.onApplicationBootstrap(),
        ).resolves.toBeUndefined();
    });

    it("swallows errors from eager declaration — bootstrap still resolves", async () => {
        const assertExchange = jest
            .fn()
            .mockRejectedValue(new Error("pre-condition failed"));
        const bindQueue = jest.fn();
        const addSetup = jest.fn();
        const amqp = {
            channel: { assertExchange, bindQueue },
            managedChannel: { addSetup },
        } as any;

        const instance = new RabbitMQDLQInitializer(amqp);
        await expect(
            instance.onApplicationBootstrap(),
        ).resolves.toBeUndefined();
        // Eager path failed, but the reconnect callback is still
        // registered — recovery still possible.
        expect(addSetup).toHaveBeenCalledTimes(1);
    });
});
