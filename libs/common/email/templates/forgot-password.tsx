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

export type ForgotPasswordEmailProps = {
    resetLink: string;
};

export const forgotPasswordEmailMeta = {
    from: EMAIL_FROM.NOTIFICATIONS,
    subject: 'Reset your Kodus password',
};

function ForgotPasswordEmail({ resetLink }: ForgotPasswordEmailProps) {
    return (
        <BrandLayout preview="Reset your Kodus password">
            <Heading style={baseHeading}>Reset your password</Heading>
            <Text style={baseText}>
                We received a request to reset the password on your Kodus
                account. Click the button below to choose a new one.
            </Text>
            <Section style={{ margin: '24px 0' }}>
                <Button href={resetLink} style={baseButton}>
                    Reset password
                </Button>
            </Section>
            <Text style={mutedText}>
                If you didn&apos;t request this, you can safely ignore this
                email — your password won&apos;t change.
            </Text>
        </BrandLayout>
    );
}

ForgotPasswordEmail.PreviewProps = {
    resetLink:
        'https://app.kodus.io/forgot-password/reset?token=preview-token-abc123',
} satisfies ForgotPasswordEmailProps;

export default ForgotPasswordEmail;
