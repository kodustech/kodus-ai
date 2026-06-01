import * as React from 'react';
import { Heading, Text } from 'react-email';

import { EMAIL_FROM } from '../from';
import { BrandLayout, baseHeading, baseText, mutedText } from './_layout';

export type MemberRemovedEmailProps = {
    /** The user who was just removed. */
    removedUserName: string;
    /** Display name of the org they were removed from. */
    organizationName: string;
    /** Display name (or email) of the admin who performed the removal. */
    removedBy: string;
};

export const memberRemovedEmailMeta = (params: {
    organizationName: string;
}) => ({
    from: EMAIL_FROM.NOTIFICATIONS,
    subject: `You've been removed from ${params.organizationName}`,
});

function MemberRemovedEmail({
    removedUserName,
    organizationName,
    removedBy,
}: MemberRemovedEmailProps) {
    return (
        <BrandLayout
            preview={`You've been removed from ${organizationName} on Kodus`}>
            <Heading style={baseHeading}>You&apos;ve been removed</Heading>
            <Text style={baseText}>
                Hi {removedUserName},
            </Text>
            <Text style={baseText}>
                You have been removed from <strong>{organizationName}</strong>{' '}
                on Kodus by {removedBy}. You no longer have access to that
                organization&apos;s projects or settings.
            </Text>
            <Text style={mutedText}>
                If you think this was a mistake, please contact your
                administrator directly.
            </Text>
        </BrandLayout>
    );
}

MemberRemovedEmail.PreviewProps = {
    removedUserName: 'Alex Rivera',
    organizationName: 'Acme Inc',
    removedBy: 'jane@acme.com',
} satisfies MemberRemovedEmailProps;

export default MemberRemovedEmail;
