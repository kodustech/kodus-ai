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

export type ReviewFailedEmailProps = {
    prUrl: string;
    repoName: string;
    reason: string;
    correlationId: string;
};

export const reviewFailedEmailMeta = (params: { repoName: string }) => ({
    from: EMAIL_FROM.NOTIFICATIONS,
    subject: `Code review failed — ${params.repoName}`,
});

function ReviewFailedEmail({
    prUrl,
    repoName,
    reason,
    correlationId,
}: ReviewFailedEmailProps) {
    return (
        <BrandLayout
            preview={`Kody could not review your pull request in ${repoName}`}>
            <Heading style={baseHeading}>Code review failed</Heading>
            <Text style={baseText}>
                Kody could not complete the code review for your pull request
                in <strong>{repoName}</strong>.
            </Text>
            <Text style={baseText}>
                <strong>Reason:</strong> {reason}
            </Text>
            <Section style={{ margin: '24px 0' }}>
                <Button href={prUrl} style={baseButton}>
                    Open pull request
                </Button>
            </Section>
            <Text style={mutedText}>
                If this persists, share this reference with support:{' '}
                <code>{correlationId}</code>.
            </Text>
        </BrandLayout>
    );
}

ReviewFailedEmail.PreviewProps = {
    prUrl: 'https://github.com/acme/api/pull/123',
    repoName: 'acme/api',
    reason: 'Upstream LLM request timed out after 3 retries',
    correlationId: 'job-9505e80b-e6df-42f9-ad0c',
} satisfies ReviewFailedEmailProps;

export default ReviewFailedEmail;
