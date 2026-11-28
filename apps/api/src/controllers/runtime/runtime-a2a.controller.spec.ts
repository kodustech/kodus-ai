import { NotFoundException } from '@nestjs/common';

import { RuntimeA2AController } from './runtime-a2a.controller';

// The public agent card advertises the Runtime: a deployment that does not
// run it (RUNTIME_ENABLED off) answers 404, as an unreleased route does.
describe('the Runtime agent card', () => {
    const saved = process.env.RUNTIME_ENABLED;
    afterEach(() => {
        if (saved === undefined) delete process.env.RUNTIME_ENABLED;
        else process.env.RUNTIME_ENABLED = saved;
    });
    const controller = () =>
        new RuntimeA2AController({
            card: () => ({ name: 'Kody Runtime', protocolVersion: '0.3.0', url: 'https://kodus.example/runtime/a2a', skills: [], capabilities: {}, defaultInputModes: [], defaultOutputModes: [], description: 'd', version: '1' }),
        } as any);

    it('is not found where the Runtime is off', () => {
        process.env.RUNTIME_ENABLED = 'false';
        expect(() => controller().card()).toThrow(NotFoundException);
    });

    it('is served where the Runtime is on', () => {
        process.env.RUNTIME_ENABLED = 'true';
        expect(controller().card()).toBeDefined();
    });
});
