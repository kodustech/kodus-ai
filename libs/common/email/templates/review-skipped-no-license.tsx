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

export type ReviewSkippedNoLicenseEmailProps = {
    prUrl: string;
    repoName: string;
    ownerContact?: string;
    authorUsername?: string;
};

export const reviewSkippedNoLicenseEmailMeta = (params: {
    repoName: string;
}) => ({
    from: EMAIL_FROM.NOTIFICATIONS,
    subject: `Review skipped — license required (${params.repoName})`,
});

function ReviewSkippedNoLicenseEmail({
    prUrl,
    repoName,
    ownerContact,
    authorUsername,
}: ReviewSkippedNoLicenseEmailProps) {
    return (
        <BrandLayout
            preview={`A pull request in ${repoName} wasn't reviewed — no active license`}>
            <Heading style={baseHeading}>Review skipped — license required</Heading>
            <Text style={baseText}>
                A pull request by <strong>{authorUsername || 'an unknown user'}</strong> in{' '}
                <strong>{repoName}</strong> was not reviewed because this user
                doesn't have an active license.
            </Text>
            <Text style={baseText}>
                {ownerContact ? (
                    <>
                        Contact <strong>{ownerContact}</strong> to enable
                        reviews.
                    </>
                ) : (
                    'Contact your organization admin to enable reviews.'
                )}
            </Text>
            <Section style={{ margin: '24px 0' }}>
                <Button href={prUrl} style={baseButton}>
                    Open pull request
                </Button>
            </Section>
            <Text style={mutedText}>
                Reviews resume automatically once an active license is in place.
            </Text>
        </BrandLayout>
    );
}

ReviewSkippedNoLicenseEmail.PreviewProps = {
    prUrl: 'https://github.com/acme/api/pull/123',
    repoName: 'acme/api',
    ownerContact: 'owner@acme.com',
} satisfies ReviewSkippedNoLicenseEmailProps;

export default ReviewSkippedNoLicenseEmail;
