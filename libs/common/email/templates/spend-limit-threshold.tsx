import * as React from 'react';
import { Heading, Text } from 'react-email';

import { EMAIL_FROM } from '../from';
import { BrandLayout, baseHeading, baseText, mutedText } from './_layout';

export type SpendLimitThresholdEmailProps = {
    percentage: number;
    limitLabel: string;
    spentLabel: string;
};

export const spendLimitThresholdEmailMeta = (params: {
    percentage: number;
}) => ({
    from: EMAIL_FROM.NOTIFICATIONS,
    subject:
        params.percentage >= 100
            ? 'BYOK monthly spend limit reached'
            : `BYOK spend at ${params.percentage}% of your monthly limit`,
});

function SpendLimitThresholdEmail({
    percentage,
    limitLabel,
    spentLabel,
}: SpendLimitThresholdEmailProps) {
    const reached = percentage >= 100;
    return (
        <BrandLayout
            preview={`BYOK spend is at ${percentage}% of your ${limitLabel} monthly limit.`}>
            <Heading style={baseHeading}>
                {reached
                    ? 'Monthly spend limit reached'
                    : `Spend at ${percentage}% of your monthly limit`}
            </Heading>
            <Text style={baseText}>
                Your BYOK model spend this month is <strong>{spentLabel}</strong>{' '}
                of your <strong>{limitLabel}</strong> limit (
                <strong>{percentage}%</strong>).
            </Text>
            <Text style={baseText}>
                This is an alert only — <strong>code reviews keep running</strong>.
                To actually stop spend, set a hard limit in your model
                provider's billing dashboard.
            </Text>
            <Text style={mutedText}>
                Spend is estimated from your token usage and the prices on your
                BYOK settings, and resets at the start of each month. Manage
                thresholds in your notification settings.
            </Text>
        </BrandLayout>
    );
}

SpendLimitThresholdEmail.PreviewProps = {
    percentage: 75,
    limitLabel: '$1,000',
    spentLabel: '$760',
} satisfies SpendLimitThresholdEmailProps;

export default SpendLimitThresholdEmail;
