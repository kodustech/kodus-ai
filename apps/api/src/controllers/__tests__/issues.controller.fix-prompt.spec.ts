import { ForbiddenException } from '@nestjs/common';

import { DEEP_SCAN_NOT_ENABLED_MESSAGE } from '@libs/security-scan/application/deep-scan.gate';

import { IssuesController } from '../issues.controller';

describe('IssuesController.buildFixPrompt', () => {
    const setup = (deepScanEnabled: boolean) => {
        const buildFixPrompt = {
            execute: jest.fn(async () => ({
                prompt: 'fix it',
                included: ['issue-1'],
                skipped: [],
            })),
        };
        const deepScanGate = {
            isEnabledFor: jest.fn(async () => deepScanEnabled),
        };
        const controller = new IssuesController(
            { user: { uuid: 'u-1', organization: { uuid: 'org-1' } } } as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            buildFixPrompt as any,
            deepScanGate as any,
        );
        return { controller, buildFixPrompt, deepScanGate };
    };

    it('refuses an organization the deep scan is not enabled for, and builds nothing', async () => {
        const { controller, buildFixPrompt, deepScanGate } = setup(false);

        const call = controller.buildFixPrompt({ ids: ['issue-1'] });
        await expect(call).rejects.toThrow(ForbiddenException);
        await expect(call).rejects.toThrow(DEEP_SCAN_NOT_ENABLED_MESSAGE);

        expect(deepScanGate.isEnabledFor).toHaveBeenCalledWith('org-1');
        expect(buildFixPrompt.execute).not.toHaveBeenCalled();
    });

    it('builds the prompt for an organization in the alpha', async () => {
        const { controller, buildFixPrompt } = setup(true);

        await expect(
            controller.buildFixPrompt({ ids: ['issue-1'] }),
        ).resolves.toEqual(expect.objectContaining({ prompt: 'fix it' }));
        expect(buildFixPrompt.execute).toHaveBeenCalledWith(['issue-1']);
    });
});
