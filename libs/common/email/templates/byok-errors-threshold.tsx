import * as React from 'react';
import { Heading, Text } from 'react-email';

import { EMAIL_FROM } from '../from';
import { BrandLayout, baseHeading, baseText, mutedText } from './_layout';

export type ByokErrorsThresholdEmailProps = {
    provider: string;
    errorCount: number;
    windowStartLabel: string;
    windowEndLabel: string;
    sampleError: string;
};

export const byokErrorsThresholdEmailMeta = (params: {
    provider: string;
}) => ({
    from: EMAIL_FROM.NOTIFICATIONS,
    subject: `BYOK LLM errors — ${params.provider} above threshold`,
});

function ByokErrorsThresholdEmail({
    provider,
    errorCount,
    windowStartLabel,
    windowEndLabel,
    sampleError,
}: ByokErrorsThresholdEmailProps) {
    return (
        <BrandLayout
            preview={`Your BYOK ${provider} model failed ${errorCount} times in the recent window.`}>
            <Heading style={baseHeading}>
                BYOK LLM errors above threshold
            </Heading>
            <Text style={baseText}>
                Your BYOK <strong>{provider}</strong> model returned{' '}
                <strong>{errorCount}</strong> errors between{' '}
                {windowStartLabel} and {windowEndLabel}. Code reviews using
                this configuration may be delayed or skipped while the
                outage continues.
            </Text>
            <Text style={baseText}>
                <strong>Latest error:</strong> {sampleError}
            </Text>
            <Text style={mutedText}>
                You will not receive another notification about this until
                a cooldown period elapses, even if errors continue. Check
                your provider dashboard or rotate keys if needed.
            </Text>
        </BrandLayout>
    );
}

ByokErrorsThresholdEmail.PreviewProps = {
    provider: 'anthropic',
    errorCount: 14,
    windowStartLabel: '14:00 UTC',
    windowEndLabel: '15:00 UTC',
    sampleError: 'Rate limit exceeded for organization',
} satisfies ByokErrorsThresholdEmailProps;

export default ByokErrorsThresholdEmail;
