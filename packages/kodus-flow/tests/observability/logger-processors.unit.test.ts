import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    addLogProcessor,
    clearLogProcessors,
    createLogger,
} from '../../src/observability/logger.js';

describe('log processors', () => {
    afterEach(() => {
        clearLogProcessors();
    });

    it('invoca processors no formato função para manter compatibilidade', () => {
        const processor = vi.fn();
        addLogProcessor(processor as any);

        const logger = createLogger('compatibility-test');
        logger.log({
            message: 'processor compatibility',
            context: 'logger-processors.unit.test',
            metadata: { token: 'secret-token', ok: true },
        });

        expect(processor).toHaveBeenCalledTimes(1);
        expect(processor).toHaveBeenCalledWith(
            'info',
            'processor compatibility',
            'compatibility-test',
            { token: '[REDACTED]', ok: true, component: 'compatibility-test' },
            undefined,
        );
    });

    it('continua invocando processors no formato objeto', () => {
        const processor = {
            process: vi.fn(),
        };
        addLogProcessor(processor);

        const logger = createLogger('object-processor-test');
        logger.warn({
            message: 'object processor',
            context: 'logger-processors.unit.test',
            metadata: { password: 'super-secret', ok: true },
        });

        expect(processor.process).toHaveBeenCalledTimes(1);
        expect(processor.process).toHaveBeenCalledWith(
            'warn',
            'object processor',
            {
                password: '[REDACTED]',
                ok: true,
                component: 'object-processor-test',
            },
            undefined,
        );
    });
});
