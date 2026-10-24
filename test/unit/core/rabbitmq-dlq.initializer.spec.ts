import { RabbitMQDLQInitializer } from "@libs/core/infrastructure/queue/rabbitmq-dlq.initializer";

/**
 * Guards against the race-condition fix in rabbitmq-dlq.initializer.ts:
 * - Must implement `onApplicationBootstrap` (runs AFTER every module's
 *   onModuleInit).
 * - Must NOT implement `onModuleInit` (used to, which caused bind
 *   attempts on queues that didn't exist yet — silently dropping
 *   delayed retries on first boot with a fresh rabbit volume).
 * - Declares the plugin-free retry path (#1663) on boot and on every
 *   reconnect, and never an `x-delayed-message` exchange.
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

    const liveChannel = () => ({
        assertExchange: jest.fn().mockResolvedValue(undefined),
        assertQueue: jest.fn().mockResolvedValue(undefined),
        bindQueue: jest.fn().mockResolvedValue(undefined),
        bindExchange: jest.fn().mockResolvedValue(undefined),
    });

    it("asserts the retry path and never an x-delayed-message exchange, eagerly and on reconnect", async () => {
        const eager = liveChannel();
        const onReconnect = liveChannel();
        const addSetup = jest
            .fn()
            .mockImplementation(async (cb: (ch: unknown) => Promise<void>) => {
                await cb(onReconnect);
            });

        const instance = new RabbitMQDLQInitializer({
            channel: eager,
            managedChannel: { addSetup },
        } as any);
        await instance.onApplicationBootstrap();
        // addSetup is not awaited by the initializer; wait for the callback.
        await addSetup.mock.results[0].value;

        for (const ch of [eager, onReconnect]) {
            // Declaring one fails on a broker without the plugin (#1663).
            expect(
                ch.assertExchange.mock.calls.map((c) => c[1]),
            ).not.toContain("x-delayed-message");
            expect(ch.assertExchange).toHaveBeenCalledWith(
                "kodus.retry",
                "headers",
                expect.any(Object),
            );
            expect(ch.assertQueue).toHaveBeenCalledWith(
                "kodus.retry.wait.5000",
                expect.objectContaining({
                    arguments: expect.objectContaining({
                        "x-queue-type": "quorum",
                        "x-message-ttl": 5000,
                        "x-dead-letter-exchange": "kodus.retry.return",
                    }),
                }),
            );
            for (const target of [
                "workflow.exchange",
                "workflow.events",
                "orchestrator.exchange",
            ]) {
                expect(ch.bindExchange).toHaveBeenCalledWith(
                    target,
                    "kodus.retry.return",
                    "",
                    { "x-match": "all", "kodus-retry-target": target },
                );
            }
        }
        // The reconnect path also re-declares the DLQs.
        expect(onReconnect.assertQueue).toHaveBeenCalledWith(
            "workflow.jobs.dlq",
            expect.any(Object),
        );
        expect(addSetup).toHaveBeenCalledTimes(1);
    });

    // A headers exchange ignores `x-` headers when matching: a binding on
    // `x-retry-bucket` matched every message, putting each retry in every
    // wait queue.
    it("binds each wait queue on a header the headers exchange actually matches", async () => {
        const ch = liveChannel();
        const instance = new RabbitMQDLQInitializer({
            channel: ch,
            managedChannel: { addSetup: jest.fn() },
        } as any);
        await instance.onApplicationBootstrap();

        expect(ch.bindQueue).toHaveBeenCalledWith(
            "kodus.retry.wait.5000",
            "kodus.retry",
            "",
            { "x-match": "all", "kodus-retry-bucket": "5000" },
        );
        for (const [, , , args] of [
            ...ch.bindQueue.mock.calls,
            ...ch.bindExchange.mock.calls,
        ]) {
            const matched = Object.keys(args).filter((k) => k !== "x-match");
            expect(matched.length).toBeGreaterThan(0);
            expect(matched.every((k) => !k.startsWith("x-"))).toBe(true);
        }
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
