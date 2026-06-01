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

export type InviteEmailProps = {
    inviteeName: string;
    inviterEmail: string;
    organizationName: string;
    teamName: string;
    inviteLink: string;
};

export function inviteEmailMeta({ teamName }: { teamName: string }) {
    return {
        from: EMAIL_FROM.NOTIFICATIONS,
        subject: `You've been invited to join ${teamName}`,
    };
}

function InviteEmail({
    inviteeName,
    inviterEmail,
    organizationName,
    teamName,
    inviteLink,
}: InviteEmailProps) {
    return (
        <BrandLayout
            preview={`Join ${teamName} on Kodus — invitation from ${inviterEmail}`}
        >
            <Heading style={baseHeading}>
                You&apos;re invited to join {teamName}
            </Heading>
            <Text style={baseText}>Hi {inviteeName},</Text>
            <Text style={baseText}>
                <strong>{inviterEmail}</strong> invited you to join{' '}
                <strong>{teamName}</strong> at <strong>{organizationName}</strong>{' '}
                on Kodus.
            </Text>
            <Section style={{ margin: '24px 0' }}>
                <Button href={inviteLink} style={baseButton}>
                    Accept invitation
                </Button>
            </Section>
            <Text style={mutedText}>
                If you weren&apos;t expecting this invitation, you can ignore
                this email.
            </Text>
        </BrandLayout>
    );
}

InviteEmail.PreviewProps = {
    inviteeName: 'Sam Carter',
    inviterEmail: 'gabriel@kodus.io',
    organizationName: 'Acme Inc',
    teamName: 'Engineering',
    inviteLink: 'https://app.kodus.io/invite/preview-uuid-1234',
} satisfies InviteEmailProps;

export default InviteEmail;
