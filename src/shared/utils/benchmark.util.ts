import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';

export async function benchmark<T>(
    payload: { label: string; metadata?: any },
    logger: PinoLoggerService,
    fn: () => Promise<T>,
): Promise<T> {
    const start = performance.now();
    const result = await fn();
    const duration = (performance.now() - start).toFixed(2);

    logger.log({
        message: `⏱️ ${payload?.label} - ${duration}ms`,
        context: 'Benchmark',
        metadata: { ...payload?.metadata },
    });

    return result;
}
