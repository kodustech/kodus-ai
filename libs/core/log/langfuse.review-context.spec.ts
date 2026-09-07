import { buildLangfuseTelemetry, toAiSdkTelemetryArgs } from './langfuse';

describe('review context telemetry privacy', () => {
    it('omits packet data and disables model input and output recording', () => {
        const contextBody = 'alpha beta secretalpha gamma delta epsilon';
        const metadata = {
            organizationId: 'org-1',
            reviewContextBody: contextBody,
        };

        const config = buildLangfuseTelemetry('code-review-finder', metadata, {
            recordInputs: false,
        });
        const telemetryArgs = toAiSdkTelemetryArgs(config);

        expect(config.metadata).toEqual({ organizationId: 'org-1' });
        expect(telemetryArgs.telemetry).toMatchObject({
            recordInputs: false,
            recordOutputs: false,
        });
        expect(JSON.stringify(telemetryArgs)).not.toContain(contextBody);
        expect(JSON.stringify(telemetryArgs)).not.toContain('secretalpha');
    });
});
