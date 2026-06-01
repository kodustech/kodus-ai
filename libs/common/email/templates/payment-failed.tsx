import * as React from 'react';
import { Button, Heading, Section, Text } from 'react-email';

import { EMAIL_FROM } from '../from';
import {
    BrandLayout,
    baseButton,
    baseHeading,
    baseText,
    mutedText,
} from './_layout';

export type PaymentFailedEmailProps = {
    /** Major-unit-formatted amount with currency, e.g. "USD 24.00". */
    formattedAmount: string;
    failureReason: string;
    /** Human label for the next retry, e.g. "March 5". */
    nextRetryAtLabel?: string;
    updatePaymentUrl?: string;
};

export const paymentFailedEmailMeta = {
    from: EMAIL_FROM.NOTIFICATIONS,
    subject: 'Payment failed — action required',
};

function PaymentFailedEmail({
    formattedAmount,
    failureReason,
    nextRetryAtLabel,
    updatePaymentUrl,
}: PaymentFailedEmailProps) {
    return (
        <BrandLayout
            preview={`Payment failed: ${formattedAmount}. Update payment method to keep your subscription active.`}>
            <Heading style={baseHeading}>Payment failed</Heading>
            <Text style={baseText}>
                We could not process your payment of{' '}
                <strong>{formattedAmount}</strong>.
            </Text>
            <Text style={baseText}>
                <strong>Reason:</strong> {failureReason}
            </Text>
            {nextRetryAtLabel ? (
                <Text style={baseText}>
                    We&apos;ll retry automatically on{' '}
                    <strong>{nextRetryAtLabel}</strong>. To avoid an
                    interruption to your service, update your payment method
                    now.
                </Text>
            ) : (
                <Text style={baseText}>
                    Update your payment method to avoid interrupting your
                    subscription.
                </Text>
            )}
            {updatePaymentUrl ? (
                <Section style={{ margin: '24px 0' }}>
                    <Button href={updatePaymentUrl} style={baseButton}>
                        Update payment method
                    </Button>
                </Section>
            ) : null}
            <Text style={mutedText}>
                If you believe this is a mistake, contact your bank or our
                support team.
            </Text>
        </BrandLayout>
    );
}

PaymentFailedEmail.PreviewProps = {
    formattedAmount: 'USD 24.00',
    failureReason: 'Card declined: insufficient funds',
    nextRetryAtLabel: 'March 5',
    updatePaymentUrl: 'https://app.kodus.io/billing',
} satisfies PaymentFailedEmailProps;

export default PaymentFailedEmail;
