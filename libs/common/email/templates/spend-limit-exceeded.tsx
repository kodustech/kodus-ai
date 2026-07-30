import * as React from 'react';
import { Heading, Text } from 'react-email';

import { EMAIL_FROM } from '../from';
import { BrandLayout, baseHeading, baseText, mutedText } from './_layout';

export type SpendLimitExceededEmailProps = {
    limitLabel: string;
    spentLabel: string;
};

export const spendLimitExceededEmailMeta = () => ({
    from: EMAIL_FROM.NOTIFICATIONS,
    subject: 'BYOK monthly spend limit exceeded',
});

function SpendLimitExceededEmail({
    limitLabel,
    spentLabel,
}: SpendLimitExceededEmailProps) {
    return (
        <BrandLayout
            preview={`Your BYOK spend (${spentLabel}) has passed your ${limitLabel} monthly limit.`}>
            <Heading style={baseHeading}>Monthly spend limit exceeded</Heading>
            <Text style={baseText}>
                Your BYOK model spend this month (<strong>{spentLabel}</strong>)
                has passed your <strong>{limitLabel}</strong> limit.
            </Text>
            <Text style={baseText}>
                <strong>This is the last alert you'll get this month.</strong>{' '}
                Code reviews continue to run — to stop spend, set a hard limit in
                your model provider's billing dashboard.
            </Text>
            <Text style={mutedText}>
                Your spend total resets at the start of next month.
            </Text>
        </BrandLayout>
    );
}

SpendLimitExceededEmail.PreviewProps = {
    limitLabel: '$1,000',
    spentLabel: '$1,240',
} satisfies SpendLimitExceededEmailProps;

export default SpendLimitExceededEmail;
