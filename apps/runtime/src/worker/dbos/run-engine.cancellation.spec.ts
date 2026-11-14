import { DBOS } from '@dbos-inc/dbos-sdk';

import * as orchestrator from '../run/run-orchestrator';
import { RunEngineService, SETUP_WORKFLOW } from './run-engine.service';

jest.mock('../run/run-orchestrator', () => ({
    ...jest.requireActual('../run/run-orchestrator'),
    runRuntimeRun: jest.fn(),
}));

describe('Run workflow cancellation wiring', () => {
    afterEach(() => jest.restoreAllMocks());

    it('reads the SDK cancellation signal inside the step that asks for it', async () => {
        const registered = jest.spyOn(DBOS, 'registerWorkflow').mockImplementation((fn) => fn as any);
        const setConfig = jest.spyOn(DBOS, 'setConfig').mockImplementation(() => undefined);
        jest.spyOn(DBOS, 'launch').mockResolvedValue(undefined);
        jest.spyOn(DBOS, 'registerQueue').mockResolvedValue(undefined);
        let insideStep = false;
        const controller = new AbortController();
        const status = jest.spyOn(DBOS, 'stepStatus', 'get').mockImplementation(() => {
            expect(insideStep).toBe(true);
            return { stepID: 1, cancelSignal: controller.signal };
        });
        jest.spyOn(DBOS, 'runStep').mockImplementation(async (fn) => {
            insideStep = true;
            try {
                return await fn();
            } finally {
                insideStep = false;
            }
        });
        jest.mocked(orchestrator.runRuntimeRun).mockImplementation(async (_req, deps) => {
            expect(status).not.toHaveBeenCalled();
            await deps.step('acquire:base:1', async () => {
                expect(deps.cancellationSignal?.()).toBe(controller.signal);
            });
            return { state: 'cancelled' };
        });
        const engine = new RunEngineService({ sweeper: false, releaseVersion: 'runtime-release-1' } as any, { forRun: () => ({}) } as any, {} as any, {} as any, {} as any, {} as any);

        await engine.onModuleInit();
        expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ applicationVersion: 'runtime-release-1' }));
        expect(status).not.toHaveBeenCalled();
        await (registered.mock.calls[0][0] as any)({}, {});

        expect(status).toHaveBeenCalledTimes(1);
    });

    it('passes a lazy SDK signal supplier to setup and reads it only inside its boot step', async () => {
        const registered = jest.spyOn(DBOS, 'registerWorkflow').mockImplementation((fn) => fn as any);
        jest.spyOn(DBOS, 'setConfig').mockImplementation(() => undefined);
        jest.spyOn(DBOS, 'launch').mockResolvedValue(undefined);
        jest.spyOn(DBOS, 'registerQueue').mockResolvedValue(undefined);
        let insideStep = false;
        const controller = new AbortController();
        const status = jest.spyOn(DBOS, 'stepStatus', 'get').mockImplementation(() => {
            expect(insideStep).toBe(true);
            return { stepID: 1, cancelSignal: controller.signal };
        });
        jest.spyOn(DBOS, 'runStep').mockImplementation(async (fn) => {
            insideStep = true;
            try { return await fn(); } finally { insideStep = false; }
        });
        const setup = { run: jest.fn(async (_cmd, step, signal) => {
            expect(status).not.toHaveBeenCalled();
            await step('boot', async () => expect(signal()).toBe(controller.signal));
            return {} as any;
        }) };
        const engine = new RunEngineService({ sweeper: false, releaseVersion: 'runtime-release-1' } as any, {} as any, {} as any, {} as any, {} as any, {} as any, setup);

        await engine.onModuleInit();
        expect(status).not.toHaveBeenCalled();
        const workflow = registered.mock.calls.find(([, options]) => options?.name === SETUP_WORKFLOW)![0];
        await (workflow as any)({});

        expect(status).toHaveBeenCalledTimes(1);
    });
});
