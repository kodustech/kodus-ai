import { DEEP_SCAN_ALPHA_ORGS_ENV, DeepScanGate } from './deep-scan.gate';

function gateWith(flag: boolean | Error) {
    const featureGate = {
        isEnabled: jest.fn(async () => {
            if (flag instanceof Error) throw flag;
            return flag;
        }),
    };
    const organizationService = {
        getReleaseTrack: jest.fn(async () => 'alpha'),
    };
    return {
        gate: new DeepScanGate(featureGate as any, organizationService as any),
        featureGate,
    };
}

describe('DeepScanGate', () => {
    afterEach(() => {
        delete process.env[DEEP_SCAN_ALPHA_ORGS_ENV];
    });

    it("asks the catalog with the organization's release track", async () => {
        const { gate, featureGate } = gateWith(true);

        await expect(gate.isEnabledFor('org-1')).resolves.toBe(true);
        expect(featureGate.isEnabled).toHaveBeenCalledWith('deep-scan', {
            identifier: 'org-1',
            organizationAndTeamData: { organizationId: 'org-1' },
            releaseTrack: 'alpha',
        });
    });

    it('is off for an organization outside the alpha', async () => {
        await expect(gateWith(false).gate.isEnabledFor('org-1')).resolves.toBe(
            false,
        );
    });

    it('fails closed when the flag cannot be read', async () => {
        await expect(
            gateWith(new Error('posthog down')).gate.isEnabledFor('org-1'),
        ).resolves.toBe(false);
    });

    it('opens to the organizations the env allow-list names', async () => {
        process.env[DEEP_SCAN_ALPHA_ORGS_ENV] = 'org-2, org-1';
        const { gate, featureGate } = gateWith(false);

        await expect(gate.isEnabledFor('org-1')).resolves.toBe(true);
        await expect(gate.isEnabledFor('org-3')).resolves.toBe(false);
        expect(featureGate.isEnabled).toHaveBeenCalledTimes(1);
    });
});
