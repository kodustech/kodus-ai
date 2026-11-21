/**
 * The Langfuse SDK at DEBUG prints every ended span with its attributes,
 * prompt and model answer included (`gen_ai.output.messages`), to the API's
 * plain logs. Before this cap a dev stack with LANGFUSE_DEBUG=true logged the
 * Runtime agent's whole answer about a customer's repository.
 */
jest.mock('@langfuse/otel', () => ({
    LangfuseSpanProcessor: class {
        forceFlush() {
            return Promise.resolve();
        }
    },
}));

import { getGlobalLogger, LogLevel, resetGlobalLogger } from '@langfuse/core';

import {
    createLangfuseSpanProcessor,
    keepSpanContentOutOfLogs,
    shutdownLangfuse,
} from '@libs/core/log/langfuse';

describe('keepSpanContentOutOfLogs', () => {
    afterEach(() => resetGlobalLogger());

    it('lifts a DEBUG Langfuse logger to INFO, so no span is dumped', () => {
        getGlobalLogger().setLevel(LogLevel.DEBUG);
        keepSpanContentOutOfLogs();
        expect(getGlobalLogger().isLevelEnabled(LogLevel.DEBUG)).toBe(false);
        expect(getGlobalLogger().isLevelEnabled(LogLevel.INFO)).toBe(true);
    });

    it('leaves a stricter level as it was', () => {
        getGlobalLogger().setLevel(LogLevel.WARN);
        keepSpanContentOutOfLogs();
        expect(getGlobalLogger().getLevel()).toBe(LogLevel.WARN);
    });
});

describe('createLangfuseSpanProcessor', () => {
    const originalEnv = { ...process.env };

    afterEach(async () => {
        process.env = { ...originalEnv };
        resetGlobalLogger();
        await shutdownLangfuse();
    });

    it('caps the SDK logger before the processor sees a span', () => {
        process.env.LANGFUSE_TRACING = 'true';
        process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
        process.env.LANGFUSE_SECRET_KEY = 'sk-test';
        getGlobalLogger().setLevel(LogLevel.DEBUG);

        expect(createLangfuseSpanProcessor()).not.toBeNull();
        expect(getGlobalLogger().isLevelEnabled(LogLevel.DEBUG)).toBe(false);
    });
});
