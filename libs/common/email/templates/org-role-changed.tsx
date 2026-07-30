import * as React from 'react';
import { Heading, Text } from 'react-email';

import { EMAIL_FROM } from '../from';
import { BrandLayout, baseHeading, baseText, mutedText } from './_layout';

export type OrgRoleChangedEmailProps = {
    affectedUserEmail: string;
    previousRole: string;
    newRole: string;
    organizationName: string;
    changedBy?: string;
};

export const orgRoleChangedEmailMeta = (params: {
    affectedUserEmail: string;
    organizationName: string;
}) => ({
    from: EMAIL_FROM.NOTIFICATIONS,
    subject: `Role changed for ${params.affectedUserEmail} in ${params.organizationName}`,
});

function OrgRoleChangedEmail({
    affectedUserEmail,
    previousRole,
    newRole,
    organizationName,
    changedBy,
}: OrgRoleChangedEmailProps) {
    return (
        <BrandLayout
            preview={`${affectedUserEmail}'s role in ${organizationName} changed to ${newRole}`}>
            <Heading style={baseHeading}>Member role changed</Heading>
            <Text style={baseText}>
                <strong>{affectedUserEmail}</strong>'s role in{' '}
                <strong>{organizationName}</strong> changed from{' '}
                <strong>{previousRole}</strong> to <strong>{newRole}</strong>.
            </Text>
            {changedBy ? (
                <Text style={mutedText}>Changed by {changedBy}.</Text>
            ) : null}
            <Text style={mutedText}>
                You're receiving this because you're an owner of{' '}
                {organizationName}. If this wasn't expected, review your
                organization's members.
            </Text>
        </BrandLayout>
    );
}

OrgRoleChangedEmail.PreviewProps = {
    affectedUserEmail: 'alex@acme.com',
    previousRole: 'contributor',
    newRole: 'repo_admin',
    organizationName: 'Acme',
    changedBy: 'jane@acme.com',
} satisfies OrgRoleChangedEmailProps;

export default OrgRoleChangedEmail;
