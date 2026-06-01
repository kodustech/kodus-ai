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

export type ConfirmationEmailProps = {
    organizationName: string;
    confirmLink: string;
};

export const confirmationEmailMeta = {
    from: EMAIL_FROM.NOTIFICATIONS,
    subject: 'Confirm your email',
};

function ConfirmationEmail({
    organizationName,
    confirmLink,
}: ConfirmationEmailProps) {
    return (
        <BrandLayout preview={`Confirm your email for ${organizationName}`}>
            <Heading style={baseHeading}>Confirm your email</Heading>
            <Text style={baseText}>
                Welcome to <strong>{organizationName}</strong> on Kodus.
                Confirm your email to finish setting up your account.
            </Text>
            <Section style={{ margin: '24px 0' }}>
                <Button href={confirmLink} style={baseButton}>
                    Confirm email
                </Button>
            </Section>
            <Text style={mutedText}>
                If you didn&apos;t create this account, you can ignore this
                email.
            </Text>
        </BrandLayout>
    );
}

ConfirmationEmail.PreviewProps = {
    organizationName: 'Acme Inc',
    confirmLink: 'https://app.kodus.io/confirm-email?token=preview-token-xyz',
} satisfies ConfirmationEmailProps;

export default ConfirmationEmail;
