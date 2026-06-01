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

export type TrialExpiringEmailProps = {
    daysRemaining: number;
    /** Human-readable end date, e.g. "March 12". */
    trialEndsAtLabel: string;
    upgradeUrl?: string;
};

export const trialExpiringEmailMeta = (params: {
    daysRemaining: number;
}) => ({
    from: EMAIL_FROM.NOTIFICATIONS,
    subject:
        params.daysRemaining === 1
            ? 'Your Kodus trial ends tomorrow'
            : `Your Kodus trial ends in ${params.daysRemaining} days`,
});

function TrialExpiringEmail({
    daysRemaining,
    trialEndsAtLabel,
    upgradeUrl,
}: TrialExpiringEmailProps) {
    const remaining =
        daysRemaining === 1
            ? 'tomorrow'
            : `in ${daysRemaining} days`;

    return (
        <BrandLayout
            preview={`Your Kodus trial ends ${remaining}. Upgrade to keep things running.`}>
            <Heading style={baseHeading}>
                Your trial ends {remaining}
            </Heading>
            <Text style={baseText}>
                Your Kodus trial ends on{' '}
                <strong>{trialEndsAtLabel}</strong>. To keep Kody reviewing
                your pull requests without interruption, upgrade your
                organization before then.
            </Text>
            {upgradeUrl ? (
                <Section style={{ margin: '24px 0' }}>
                    <Button href={upgradeUrl} style={baseButton}>
                        Upgrade plan
                    </Button>
                </Section>
            ) : null}
            <Text style={mutedText}>
                If you decide not to upgrade, your organization will move
                to the free plan automatically when the trial ends.
            </Text>
        </BrandLayout>
    );
}

TrialExpiringEmail.PreviewProps = {
    daysRemaining: 7,
    trialEndsAtLabel: 'March 12',
    upgradeUrl: 'https://app.kodus.io/billing',
} satisfies TrialExpiringEmailProps;

export default TrialExpiringEmail;
