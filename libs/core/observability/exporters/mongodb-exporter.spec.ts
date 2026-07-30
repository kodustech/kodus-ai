import { MongoDBExporter } from './mongodb-exporter';

function buildLog(message: string, payloadSize = 0): any {
    return {
        timestamp: new Date(),
        level: 'info',
        message,
        component: 'test-component',
        correlationId: 'corr-1',
        tenantId: 'tenant-1',
        metadata: {
            component: 'test-component',
            level: 'info',
            tenantId: 'tenant-1',
        },
        attributes:
            payloadSize > 0
                ? { payload: 'x'.repeat(payloadSize) }
                : { payload: 'ok' },
        createdAt: new Date(),
    };
}

describe('MongoDBExporter (log flush resilience)', () => {
    const originalLogLevel = process.env.API_LOG_LEVEL;

    beforeEach(() => {
        process.env.API_LOG_LEVEL = 'info';
    });

    afterAll(() => {
        process.env.API_LOG_LEVEL = originalLogLevel;
    });

    it('drops non-retryable oversized BSON failures instead of rebuffering forever', async () => {
        const exporter = new MongoDBExporter({
            batchSize: 500,
            flushIntervalMs: 60_000,
        });
        const insertMany = jest.fn().mockRejectedValue(
            new Error(
                'BSONObj size: 34233013 (0x20A5AB5) is invalid. Size must be between 0 and 16793600(16MB)',
            ),
        );

        (exporter as any).collections = {
            logs: { insertMany },
            telemetry: { insertMany: jest.fn() },
        };
        (exporter as any).handleConnectionError = jest
            .fn()
            .mockResolvedValue(undefined);
        (exporter as any).logBuffer = [buildLog('oversized batch candidate')];

        await (exporter as any).flushLogs();

        expect(insertMany).toHaveBeenCalledTimes(1);
        expect((exporter as any).logBuffer).toHaveLength(0);
    });

    it('keeps retrying transient connection failures', async () => {
        const exporter = new MongoDBExporter({
            batchSize: 500,
            flushIntervalMs: 60_000,
        });
        const transient = new Error('Topology is closed');
        transient.name = 'MongoNetworkError';
        const insertMany = jest.fn().mockRejectedValue(transient);

        (exporter as any).collections = {
            logs: { insertMany },
            telemetry: { insertMany: jest.fn() },
        };
        (exporter as any).handleConnectionError = jest
            .fn()
            .mockResolvedValue(undefined);
        (exporter as any).logBuffer = [buildLog('transient retry candidate')];

        await (exporter as any).flushLogs();

        expect((exporter as any).logBuffer).toHaveLength(1);
    });

    it('caps log buffer by bytes and keeps the newest entries when capacity is exceeded', async () => {
        const exporter = new MongoDBExporter({
            batchSize: 9999,
            flushIntervalMs: 60_000,
        });
        (exporter as any).maxLogBufferBytes = 5 * 1024;
        (exporter as any).logBuffer = [
            buildLog('older-log', 4 * 1024),
            buildLog('newer-log', 4 * 1024),
        ];
        (exporter as any).trimLogBufferToCapacity();

        const buffered = (exporter as any).logBuffer;
        expect(buffered).toHaveLength(1);
        expect(buffered[0].message).toBe('newer-log');
    });

    it('drops a single log entry that exceeds the per-document byte safety limit', async () => {
        const exporter = new MongoDBExporter({
            batchSize: 9999,
            flushIntervalMs: 60_000,
        });
        (exporter as any).maxLogDocumentBytes = 1024;
        const insertMany = jest.fn().mockResolvedValue(undefined);
        (exporter as any).collections = {
            logs: { insertMany },
            telemetry: { insertMany: jest.fn() },
        };
        (exporter as any).logBuffer = [
            buildLog('too-large-log', 3 * 1024),
            buildLog('fits', 100),
        ];

        await (exporter as any).flushLogs();

        expect(insertMany).toHaveBeenCalledTimes(1);
        expect(insertMany.mock.calls[0][0]).toHaveLength(1);
        expect(insertMany.mock.calls[0][0][0].message).toBe('fits');
        expect((exporter as any).logBuffer).toHaveLength(0);
    });

    it('re-buffers remaining batches instead of hitting a null handle after a mid-flush connection loss', async () => {
        const exporter = new MongoDBExporter({
            batchSize: 9999,
            flushIntervalMs: 60_000,
        });
        // Force two separate insert batches.
        (exporter as any).maxLogInsertBatchBytes = 1024;

        const transient = new Error('Topology is closed');
        transient.name = 'MongoNetworkError';
        const insertMany = jest.fn().mockRejectedValue(transient);
        (exporter as any).collections = {
            logs: { insertMany },
            telemetry: { insertMany: jest.fn() },
        };
        // Mimic the real handleConnectionError -> resetConnection nulling the handle.
        (exporter as any).handleConnectionError = jest
            .fn()
            .mockImplementation(async () => {
                (exporter as any).collections = null;
            });
        const errorSpy = jest.spyOn((exporter as any).logger, 'error');
        (exporter as any).logBuffer = [
            buildLog('batch-one', 800),
            buildLog('batch-two', 800),
        ];

        await expect((exporter as any).flushLogs()).resolves.toBeUndefined();

        // Only the first batch is actually attempted; the second sees a null
        // handle and is re-buffered rather than throwing a (logged) TypeError.
        expect(insertMany).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const messages = (exporter as any).logBuffer.map((l: any) => l.message);
        expect(messages).toContain('batch-one');
        expect(messages).toContain('batch-two');
    });

    it('does not buffer logs when Mongo observability is disabled', async () => {
        const exporter = new MongoDBExporter({
            batchSize: 500,
            flushIntervalMs: 60_000,
            enableObservability: false,
        });

        await exporter.exportLog(
            'error',
            'should-not-buffer',
            { component: 'test-component' } as any,
        );

        expect((exporter as any).logBuffer).toHaveLength(0);
    });
});
