import Pyroscope from '@pyroscope/nodejs';
import { createLogger } from '@libs/core/log/logger';

const logger = createLogger('Pyroscope');

export interface PyroscopeConfig {
    appName: string;
    serverAddress?: string;
    tags?: Record<string, string>;
    enableHeapProfiling?: boolean;
}

let isInitialized = false;

export function initPyroscope(config: PyroscopeConfig): void {
    const serverAddress =
        config.serverAddress || process.env.PYROSCOPE_SERVER_ADDRESS;
    const enableHeapProfiling =
        config.enableHeapProfiling ??
        process.env.PYROSCOPE_HEAP_PROFILING === 'true';

    if (!serverAddress) {
        logger.debug({
            message: 'PYROSCOPE_SERVER_ADDRESS not set, skipping profiling',
            context: 'Pyroscope',
        });
        return;
    }

    if (isInitialized) {
        logger.debug({
            message: 'Already initialized, skipping',
            context: 'Pyroscope',
        });
        return;
    }

    try {
        Pyroscope.init({
            serverAddress,
            appName: config.appName,
            tags: {
                env: process.env.NODE_ENV || 'development',
                ...config.tags,
            },
            // Heap profiling configuration
            heap: enableHeapProfiling
                ? {
                      samplingIntervalBytes: 524288, // 512KB - sample every 512KB allocated
                      stackDepth: 32, // Capture up to 32 frames in stack traces
                  }
                : undefined,
        });

        // Start CPU/Wall profiling
        Pyroscope.start();

        // Start heap profiling if enabled
        if (enableHeapProfiling) {
            Pyroscope.startHeapProfiling();
            logger.log({
                message: `Heap profiling enabled for ${config.appName}`,
                context: 'Pyroscope',
            });
        }

        isInitialized = true;

        logger.log({
            message: `Profiling started for ${config.appName} -> ${serverAddress}`,
            context: 'Pyroscope',
        });
    } catch (error) {
        logger.error({
            message: 'Failed to initialize Pyroscope',
            context: 'Pyroscope',
            error: error instanceof Error ? error : new Error(String(error)),
        });
    }
}

export async function stopPyroscope(): Promise<void> {
    if (isInitialized) {
        await Pyroscope.stopHeapProfiling();
        await Pyroscope.stop();
        isInitialized = false;
        logger.log({
            message: 'Profiling stopped',
            context: 'Pyroscope',
        });
    }
}
