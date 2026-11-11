import { ObservabilitySystem } from './observability';

describe('ObservabilitySystem shutdown signals', () => {
    const signals = ['SIGTERM', 'SIGINT'] as const;

    afterEach(() => {
        delete (process as any).__kodusObsHandlersInstalled;
    });

    function createSystem() {
        const baseline = Object.fromEntries(
            signals.map((signal) => [signal, process.listeners(signal)]),
        );
        const system = new ObservabilitySystem({
            logging: { level: 'error', enabled: false },
        });
        const exporter = {
            name: 'fake',
            shutdown: jest.fn().mockResolvedValue(undefined),
        };
        (system as any).exporters = [exporter];
        const installed = (signal: (typeof signals)[number]) =>
            process
                .listeners(signal)
                .filter((l) => !baseline[signal].includes(l));
        return { system, exporter, installed };
    }

    // enableShutdownHooks() removes Nest's listener and re-sends the signal
    // once the hooks have run; the process only exits if nothing else handles it.
    it.each(signals)(
        'leaves no %s listener behind once it has handled the signal',
        async (signal) => {
            const { installed } = createSystem();
            const [handler] = installed(signal);
            expect(handler).toBeDefined();

            process.emit(signal);
            await new Promise((resolve) => setImmediate(resolve));

            expect(installed(signal)).toHaveLength(0);
        },
    );

    it('shuts the exporters down once however often it is called', async () => {
        const { system, exporter, installed } = createSystem();

        await Promise.all([system.shutdown(), system.shutdown()]);
        await system.shutdown();

        expect(exporter.shutdown).toHaveBeenCalledTimes(1);
        installed('SIGTERM').forEach((l) =>
            process.removeListener('SIGTERM', l as any),
        );
        installed('SIGINT').forEach((l) =>
            process.removeListener('SIGINT', l as any),
        );
    });
});
