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

export type DomainVerificationEmailProps = {
    organizationName: string;
    domain: string;
    confirmLink: string;
};

export function domainVerificationEmailMeta({ domain }: { domain: string }) {
    return {
        from: EMAIL_FROM.NOTIFICATIONS,
        subject: `Verify ${domain} for SSO`,
    };
}

function DomainVerificationEmail({
    organizationName,
    domain,
    confirmLink,
}: DomainVerificationEmailProps) {
    return (
        <BrandLayout preview={`Verify ${domain} to enable SSO`}>
            <Heading style={baseHeading}>Verify your domain</Heading>
            <Text style={baseText}>
                Confirm that you own <strong>{domain}</strong> to enable SSO
                for <strong>{organizationName}</strong>.
            </Text>
            <Section style={{ margin: '24px 0' }}>
                <Button href={confirmLink} style={baseButton}>
                    Verify domain
                </Button>
            </Section>
            <Text style={mutedText}>
                If you didn&apos;t request this verification, you can ignore
                this email.
            </Text>
        </BrandLayout>
    );
}

DomainVerificationEmail.PreviewProps = {
    organizationName: 'Acme Inc',
    domain: 'acme.com',
    confirmLink:
        'https://app.kodus.io/organization/sso?domainVerificationToken=preview-token',
} satisfies DomainVerificationEmailProps;

export default DomainVerificationEmail;
