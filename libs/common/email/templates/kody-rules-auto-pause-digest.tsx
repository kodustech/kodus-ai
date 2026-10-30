import * as React from 'react';
import { Heading, Link, Section, Text } from 'react-email';

import { EMAIL_FROM } from '../from';
import { BrandLayout, baseHeading, baseText, mutedText } from './_layout';

export type KodyRulesAutoPauseDigestEmailProps = {
    rules: Array<{
        title: string;
        /** Repository name, or "Global" / "All repositories". */
        scopeLabel: string;
        reason: string;
        url: string;
        resumed: boolean;
    }>;
    settingsUrl: string;
};

export const kodyRulesAutoPauseDigestEmailMeta = (params: {
    count: number;
}) => ({
    from: EMAIL_FROM.NOTIFICATIONS,
    subject: `${params.count} Kody ${
        params.count === 1 ? 'rule was' : 'rules were'
    } paused since the last digest`,
});

const ruleTitle: React.CSSProperties = {
    ...baseText,
    margin: '0 0 4px',
};

const ruleDetail: React.CSSProperties = {
    ...mutedText,
    margin: '0 0 16px',
};

function KodyRulesAutoPauseDigestEmail({
    rules,
    settingsUrl,
}: KodyRulesAutoPauseDigestEmailProps) {
    const count = rules.length;
    return (
        <BrandLayout
            preview={`${count} Kody ${
                count === 1 ? 'rule was' : 'rules were'
            } paused because ${count === 1 ? 'it was' : 'they were'} ignored or downvoted.`}
        >
            <Heading style={baseHeading}>
                {count === 1
                    ? 'A Kody rule was paused since the last digest'
                    : `${count} Kody rules were paused since the last digest`}
            </Heading>
            <Text style={baseText}>
                Kody paused {count === 1 ? 'this rule' : 'these rules'} because
                developers kept ignoring or downvoting what{' '}
                {count === 1 ? 'it' : 'they'} flagged. A paused rule is skipped
                on new reviews. Open a rule to see its numbers and resume it.
            </Text>
            <Section style={{ margin: '16px 0' }}>
                {rules.map((rule, i) => (
                    <React.Fragment key={i}>
                        <Text style={ruleTitle}>
                            <Link href={rule.url}>
                                <strong>{rule.title}</strong>
                            </Link>{' '}
                            · {rule.scopeLabel}
                            {rule.resumed ? ' · Already resumed' : ''}
                        </Text>
                        <Text style={ruleDetail}>{rule.reason}</Text>
                    </React.Fragment>
                ))}
            </Section>
            <Text style={mutedText}>
                Automatic pausing is controlled by the &quot;Pause ignored and
                noisy rules&quot; setting in{' '}
                <Link href={settingsUrl}>Kody Rules settings</Link>.
            </Text>
        </BrandLayout>
    );
}

KodyRulesAutoPauseDigestEmail.PreviewProps = {
    rules: [
        {
            title: 'No console.log in production',
            scopeLabel: 'acme/api',
            reason: 'Ignored: 2 of 14 suggestions implemented in the last 30 days.',
            url: 'https://app.kodus.io/settings/code-review/1/kody-rules?rule=r-1',
            resumed: false,
        },
        {
            title: 'Prefer early returns',
            scopeLabel: 'All repositories',
            reason: 'Noisy: 5 👎 and 1 👍 on 20 suggestions in the last 30 days.',
            url: 'https://app.kodus.io/settings/code-review/global/kody-rules?rule=r-2',
            resumed: true,
        },
    ],
    settingsUrl: 'https://app.kodus.io/settings/code-review/global/kody-rules',
} satisfies KodyRulesAutoPauseDigestEmailProps;

export default KodyRulesAutoPauseDigestEmail;
