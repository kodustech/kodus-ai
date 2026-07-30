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

export type ReviewAutoApprovedEmailProps = {
    prUrl: string;
    repoName: string;
};

export const reviewAutoApprovedEmailMeta = (params: { repoName: string }) => ({
    from: EMAIL_FROM.NOTIFICATIONS,
    subject: `Pull request auto-approved — ${params.repoName}`,
});

function ReviewAutoApprovedEmail({
    prUrl,
    repoName,
}: ReviewAutoApprovedEmailProps) {
    return (
        <BrandLayout
            preview={`Kody auto-approved a pull request in ${repoName}`}>
            <Heading style={baseHeading}>Pull request auto-approved</Heading>
            <Text style={baseText}>
                Kody auto-approved a pull request in <strong>{repoName}</strong>{' '}
                — it met your configured approval criteria.
            </Text>
            <Section style={{ margin: '24px 0' }}>
                <Button href={prUrl} style={baseButton}>
                    Open pull request
                </Button>
            </Section>
            <Text style={mutedText}>
                You're receiving this because auto-approval notifications are
                enabled for your role. Manage them in your notification
                settings.
            </Text>
        </BrandLayout>
    );
}

ReviewAutoApprovedEmail.PreviewProps = {
    prUrl: 'https://github.com/acme/api/pull/123',
    repoName: 'acme/api',
} satisfies ReviewAutoApprovedEmailProps;

export default ReviewAutoApprovedEmail;
