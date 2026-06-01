import * as React from 'react';
import {
    Button,
    Column,
    Heading,
    Row,
    Section,
    Text,
} from 'react-email';

import { EMAIL_FROM } from '../from';
import {
    BrandLayout,
    baseButton,
    baseHeading,
    baseText,
    mutedText,
} from './_layout';

export type TopCategory = {
    category: string;
    count: number;
};

export type Trend = 'improved' | 'worsened' | 'unchanged';

export type WeeklyRecapEmailProps = {
    devName: string;
    company: string;
    startDate: string;
    endDate: string;
    numPRs: number;
    reviewedPRs: number;
    kodySuggestions: number;
    suggestionsApplied: number;
    criticalIssues: number;
    bugRatio: number; // 0..1 (e.g. 0.12 = 12%)
    bugRatioTrend: Trend;
    bugRatioChangePct: number;
    deployFrequency: number;
    deployFrequencyTrend: Trend;
    deployFrequencyChangePct: number;
    prCycleTime: number; // hours (P75)
    prCycleTimeTrend: Trend;
    prCycleTimeChangePct: number;
    reviewTime: number; // hours (avg)
    topContributorName: string;
    topContributorPRs: number;
    companyRank: number;
    companyRankPercentile: number;
    companyRankBarFill: number;
    showRanking: boolean;
    topAnalysisTypes: TopCategory[];
    cockpitLink: string;
};

export function weeklyRecapEmailMeta({
    kodySuggestions,
    criticalIssues,
}: {
    kodySuggestions: number;
    criticalIssues: number;
}) {
    const sg = `${kodySuggestions} suggestion${
        kodySuggestions === 1 ? '' : 's'
    }`;
    const ci = `${criticalIssues} critical caught`;
    return {
        from: EMAIL_FROM.NOTIFICATIONS,
        subject: `⚡️ Your Kodus week: ${sg}, ${ci}`,
    };
}

// Brand-aligned palette only. Kodus is peach (#f8b76d) + brown (#443024).
// Status colors come from the design system tokens (#fa5867 brand red,
// #42be65 brand green) — no off-brand blues / generic amber.
type Accent = {
    bg: string;
    border: string;
    valueColor: string;
    labelColor: string;
};

const ACCENTS: Record<'peach' | 'red' | 'neutral', Accent> = {
    peach: {
        bg: '#FEF3E2',
        border: '#FDE0B8',
        valueColor: '#443024',
        labelColor: '#92571F',
    },
    red: {
        bg: '#FEE7E7',
        border: '#FBCACA',
        valueColor: '#7A1F22',
        labelColor: '#9B1F26',
    },
    neutral: {
        bg: '#F9FAFB',
        border: '#E5E7EB',
        valueColor: '#443024',
        labelColor: '#6B7280',
    },
};

const cardBase = (a: Accent): React.CSSProperties => ({
    backgroundColor: a.bg,
    border: `1px solid ${a.border}`,
    borderRadius: 8,
    margin: 0,
    padding: '14px 16px',
});

const statValueBase = (a: Accent): React.CSSProperties => ({
    color: a.valueColor,
    fontSize: 24,
    fontWeight: 700,
    lineHeight: '30px',
    margin: 0,
});

const statLabelBase = (a: Accent): React.CSSProperties => ({
    color: a.labelColor,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: '0.04em',
    lineHeight: '16px',
    margin: '4px 0 0',
    textTransform: 'uppercase',
});

const sectionHeading: React.CSSProperties = {
    color: '#111827',
    fontSize: 16,
    fontWeight: 600,
    lineHeight: '22px',
    margin: '28px 0 10px',
};

const sectionSubhead: React.CSSProperties = {
    color: '#6B7280',
    fontSize: 13,
    lineHeight: '18px',
    margin: '0 0 14px',
};

const tableRow: React.CSSProperties = {
    borderBottom: '1px solid #F3F4F6',
    padding: '12px 0',
};

const tableLabel: React.CSSProperties = {
    color: '#374151',
    fontSize: 14,
    lineHeight: '20px',
    margin: 0,
};

const tableValue: React.CSSProperties = {
    color: '#111827',
    fontSize: 15,
    fontWeight: 700,
    lineHeight: '22px',
    margin: 0,
    textAlign: 'right',
};

// Trend colors from the design system (apps/web globals.css).
const trendUp: React.CSSProperties = {
    color: '#1F7A47', // darker tone of brand --color-success #42be65 for AA contrast on white
    fontSize: 12,
    fontWeight: 600,
    lineHeight: '16px',
    margin: '2px 0 0',
    textAlign: 'right',
};

const trendDown: React.CSSProperties = {
    ...trendUp,
    color: '#B12A30', // darker tone of brand --color-danger #fa5867
};

const trendFlat: React.CSSProperties = { ...trendUp, color: '#6B7280' };

const categoryPill: React.CSSProperties = {
    backgroundColor: '#FEF3E2',
    border: '1px solid #f8b76d',
    borderRadius: 999,
    color: '#443024',
    display: 'inline-block',
    fontSize: 12,
    fontWeight: 600,
    margin: '0 6px 6px 0',
    padding: '4px 10px',
};

// Headline hero — the standout metric of the week, big and colorful.
const headlineHero: React.CSSProperties = {
    backgroundColor: '#FEF3E2',
    border: '1px solid #f8b76d',
    borderRadius: 12,
    margin: '20px 0 8px',
    padding: '20px 22px',
};

const headlineKicker: React.CSSProperties = {
    color: '#92571F',
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: '0.06em',
    lineHeight: '16px',
    margin: 0,
    textTransform: 'uppercase',
};

const headlineValue: React.CSSProperties = {
    color: '#443024',
    fontSize: 34,
    fontWeight: 800,
    lineHeight: '40px',
    margin: '4px 0 4px',
};

const headlineCaption: React.CSSProperties = {
    color: '#6B5644',
    fontSize: 14,
    lineHeight: '20px',
    margin: 0,
};

const rankingHero: React.CSSProperties = {
    backgroundColor: '#443024',
    borderRadius: 8,
    color: '#FFFFFF',
    margin: '24px 0 0',
    padding: '20px 24px',
};

const rankBadge: React.CSSProperties = {
    color: '#f8b76d',
    fontSize: 14,
    fontWeight: 600,
    letterSpacing: '0.04em',
    lineHeight: '20px',
    margin: 0,
    textTransform: 'uppercase',
};

const rankNumber: React.CSSProperties = {
    color: '#FFFFFF',
    fontSize: 36,
    fontWeight: 700,
    lineHeight: '40px',
    margin: '4px 0 0',
};

const rankSubtitle: React.CSSProperties = {
    color: '#FFFFFF',
    fontSize: 13,
    lineHeight: '20px',
    margin: '4px 0 0',
    opacity: 0.85,
};

const rankBarTrack: React.CSSProperties = {
    backgroundColor: '#5b4438',
    borderRadius: 999,
    height: 6,
    margin: '16px 0 0',
    overflow: 'hidden',
    width: '100%',
};

const rankBarFill = (percent: number): React.CSSProperties => ({
    backgroundColor: '#f8b76d',
    borderRadius: 999,
    display: 'block',
    height: 6,
    width: `${Math.max(2, Math.min(percent, 100))}%`,
});

const rankShare: React.CSSProperties = {
    color: '#FFFFFF',
    fontSize: 12,
    lineHeight: '18px',
    margin: '8px 0 0',
    opacity: 0.7,
};

type RankTier = {
    emoji: string;
    label: string;
};

function resolveTier(rank: number, percentile: number): RankTier {
    if (!Number.isFinite(rank) || rank < 1) {
        return { emoji: '📊', label: 'Tracking' };
    }
    if (rank === 1) return { emoji: '🥇', label: 'Top performer' };
    if (rank === 2) return { emoji: '🥈', label: 'On the podium' };
    if (rank === 3) return { emoji: '🥉', label: 'On the podium' };

    if (percentile <= 5) return { emoji: '🏆', label: 'Top 5%' };
    if (percentile <= 10) return { emoji: '🏆', label: 'Top 10%' };
    if (percentile <= 25) return { emoji: '⭐', label: 'Top 25%' };
    if (percentile <= 50) return { emoji: '📈', label: 'Top half' };
    return { emoji: '📊', label: 'Keep shipping' };
}

function StatCard({
    label,
    value,
    accent,
    icon,
}: {
    label: string;
    value: string;
    accent: keyof typeof ACCENTS;
    icon?: string;
}) {
    const a = ACCENTS[accent];
    return (
        <Section style={cardBase(a)}>
            <Text style={statValueBase(a)}>{value}</Text>
            <Text style={statLabelBase(a)}>
                {icon ? `${icon} ` : ''}
                {label}
            </Text>
        </Section>
    );
}

function StatPair({
    left,
    right,
}: {
    left: {
        label: string;
        value: string;
        accent: keyof typeof ACCENTS;
        icon?: string;
    };
    right: {
        label: string;
        value: string;
        accent: keyof typeof ACCENTS;
        icon?: string;
    };
}) {
    return (
        <Row style={{ margin: '0 0 10px' }}>
            <Column style={{ paddingRight: 5, width: '50%' }}>
                <StatCard {...left} />
            </Column>
            <Column style={{ paddingLeft: 5, width: '50%' }}>
                <StatCard {...right} />
            </Column>
        </Row>
    );
}

function trendBadge(
    trend: Trend,
    changePct: number,
    direction: 'up-good' | 'down-good',
): { style: React.CSSProperties; text: string } | null {
    if (trend === 'unchanged' || !Number.isFinite(changePct)) {
        return { style: trendFlat, text: 'flat vs last week' };
    }
    const isGood =
        (direction === 'up-good' && trend === 'improved') ||
        (direction === 'down-good' && trend === 'improved');
    const arrow = trend === 'improved' ? '↗' : '↘';
    const abs = Math.abs(changePct).toFixed(0);
    return {
        style: isGood ? trendUp : trendDown,
        text: `${arrow} ${abs}% vs last week`,
    };
}

function fmtNum(n: number, digits = 0): string {
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString('en-US', {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
    });
}

function fmtHours(h: number): string {
    if (!Number.isFinite(h) || h <= 0) return '—';
    if (h < 1) return `${Math.round(h * 60)}m`;
    if (h < 24) return `${h.toFixed(1)}h`;
    return `${(h / 24).toFixed(1)}d`;
}

function fmtPercent(p: number, digits = 1): string {
    if (!Number.isFinite(p)) return '—';
    return `${p.toFixed(digits)}%`;
}

function fmtDateRange(start: string, end: string): string {
    // Pin to UTC: input is `YYYY-MM-DDT00:00:00Z`, but without an
    // explicit timeZone, toLocaleDateString uses the server's local
    // zone and a host in PST/EST shifts the recap window back by a
    // day in the rendered email.
    const opts: Intl.DateTimeFormatOptions = {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
    };
    try {
        const s = new Date(`${start}T00:00:00Z`).toLocaleDateString(
            'en-US',
            opts,
        );
        const e = new Date(`${end}T00:00:00Z`).toLocaleDateString(
            'en-US',
            opts,
        );
        return `${s} – ${e}`;
    } catch {
        return `${start} – ${end}`;
    }
}

type Headline = {
    kicker: string;
    value: string;
    caption: string;
};

function pickHeadline({
    suggestionsApplied,
    criticalIssues,
    reviewedPRs,
    company,
}: {
    suggestionsApplied: number;
    criticalIssues: number;
    reviewedPRs: number;
    company: string;
}): Headline {
    if (criticalIssues >= 1) {
        return {
            kicker: 'Caught before merge',
            value: `${fmtNum(criticalIssues)} critical ${
                criticalIssues === 1 ? 'issue' : 'issues'
            }`,
            caption: `Kody flagged ${fmtNum(
                criticalIssues,
            )} critical ${
                criticalIssues === 1 ? 'issue' : 'issues'
            } before they reached main.`,
        };
    }
    if (suggestionsApplied >= 10) {
        return {
            kicker: 'Code improved',
            value: `${fmtNum(suggestionsApplied)} suggestions`,
            caption: `Your team accepted ${fmtNum(
                suggestionsApplied,
            )} Kody suggestions — every one of them shipped.`,
        };
    }
    return {
        kicker: 'Shipping pace',
        value: `${fmtNum(reviewedPRs)} ${reviewedPRs === 1 ? 'PR' : 'PRs'}`,
        caption: `${company} closed ${fmtNum(reviewedPRs)} ${
            reviewedPRs === 1 ? 'pull request' : 'pull requests'
        } this week.`,
    };
}

function WeeklyRecapEmail({
    devName,
    company,
    startDate,
    endDate,
    reviewedPRs,
    kodySuggestions,
    suggestionsApplied,
    criticalIssues,
    bugRatio,
    bugRatioTrend,
    bugRatioChangePct,
    deployFrequency,
    deployFrequencyTrend,
    deployFrequencyChangePct,
    prCycleTime,
    prCycleTimeTrend,
    prCycleTimeChangePct,
    reviewTime,
    topContributorName,
    topContributorPRs,
    companyRank,
    companyRankPercentile,
    companyRankBarFill,
    showRanking,
    topAnalysisTypes,
    cockpitLink,
}: WeeklyRecapEmailProps) {
    const period = fmtDateRange(startDate, endDate);
    const applyRate =
        kodySuggestions > 0
            ? (suggestionsApplied / kodySuggestions) * 100
            : 0;
    const tier = resolveTier(companyRank, companyRankPercentile);
    const headline = pickHeadline({
        suggestionsApplied,
        criticalIssues,
        reviewedPRs,
        company,
    });

    const deployBadge = trendBadge(
        deployFrequencyTrend,
        deployFrequencyChangePct,
        'up-good',
    );
    const cycleBadge = trendBadge(
        prCycleTimeTrend,
        prCycleTimeChangePct,
        'down-good',
    );
    const bugBadge = trendBadge(bugRatioTrend, bugRatioChangePct, 'down-good');

    return (
        <BrandLayout
            preview={`${company} · ${reviewedPRs} PRs reviewed · ${kodySuggestions} suggestions · ${fmtNum(
                criticalIssues,
            )} critical caught`}
        >
            <Heading style={baseHeading}>Hi {devName} 👋</Heading>
            <Text style={baseText}>
                Here&apos;s how <strong>{company}</strong> shipped this week.
            </Text>
            <Text style={mutedText}>{period}</Text>

            <Section style={headlineHero}>
                <Text style={headlineKicker}>{headline.kicker}</Text>
                <Text style={headlineValue}>{headline.value}</Text>
                <Text style={headlineCaption}>{headline.caption}</Text>
            </Section>

            <Text style={sectionHeading}>By the numbers</Text>
            <Text style={sectionSubhead}>
                What Kody did across {fmtNum(reviewedPRs)}{' '}
                {reviewedPRs === 1 ? 'PR' : 'PRs'} this week.
            </Text>
            <Section>
                <StatPair
                    left={{
                        icon: '📦',
                        label: 'PRs reviewed',
                        value: fmtNum(reviewedPRs),
                        accent: 'neutral',
                    }}
                    right={{
                        icon: '💡',
                        label: 'Kody suggestions',
                        value: fmtNum(kodySuggestions),
                        accent: 'peach',
                    }}
                />
                <StatPair
                    left={{
                        icon: '✅',
                        label: 'Suggestions applied',
                        value: `${fmtNum(suggestionsApplied)} · ${fmtPercent(
                            applyRate,
                            0,
                        )}`,
                        accent: 'peach',
                    }}
                    right={{
                        icon: '🚨',
                        label: 'Critical issues',
                        value: fmtNum(criticalIssues),
                        accent: 'red',
                    }}
                />
                {topContributorName ? (
                    <Section style={cardBase(ACCENTS.neutral)}>
                        <Text style={statValueBase(ACCENTS.neutral)}>
                            {topContributorName}
                        </Text>
                        <Text style={statLabelBase(ACCENTS.neutral)}>
                            🏅 Top contributor · {fmtNum(topContributorPRs)}{' '}
                            {topContributorPRs === 1 ? 'PR' : 'PRs'}
                        </Text>
                    </Section>
                ) : null}
            </Section>

            <Text style={sectionHeading}>Delivery health</Text>
            <Text style={sectionSubhead}>
                Trends compared to the previous week.
            </Text>
            <Section>
                <Row style={tableRow}>
                    <Column>
                        <Text style={tableLabel}>🚀 Deploy frequency</Text>
                    </Column>
                    <Column>
                        <Text style={tableValue}>
                            {fmtNum(deployFrequency)}{' '}
                            {deployFrequency === 1 ? 'deploy' : 'deploys'}
                        </Text>
                        {deployBadge ? (
                            <Text style={deployBadge.style}>
                                {deployBadge.text}
                            </Text>
                        ) : null}
                    </Column>
                </Row>
                <Row style={tableRow}>
                    <Column>
                        <Text style={tableLabel}>⏳ PR cycle time (P75)</Text>
                    </Column>
                    <Column>
                        <Text style={tableValue}>{fmtHours(prCycleTime)}</Text>
                        {cycleBadge ? (
                            <Text style={cycleBadge.style}>
                                {cycleBadge.text}
                            </Text>
                        ) : null}
                    </Column>
                </Row>
                <Row style={tableRow}>
                    <Column>
                        <Text style={tableLabel}>👀 Review time (avg)</Text>
                    </Column>
                    <Column>
                        <Text style={tableValue}>{fmtHours(reviewTime)}</Text>
                    </Column>
                </Row>
                <Row style={{ ...tableRow, borderBottom: 'none' }}>
                    <Column>
                        <Text style={tableLabel}>🐞 Bug ratio</Text>
                    </Column>
                    <Column>
                        <Text style={tableValue}>
                            {fmtPercent(bugRatio * 100, 1)}
                        </Text>
                        {bugBadge ? (
                            <Text style={bugBadge.style}>{bugBadge.text}</Text>
                        ) : null}
                    </Column>
                </Row>
            </Section>

            {topAnalysisTypes.length > 0 ? (
                <>
                    <Text style={sectionHeading}>
                        🎯 What Kody focused on
                    </Text>
                    <Text style={sectionSubhead}>
                        Top categories of suggestions this week.
                    </Text>
                    <Section>
                        {topAnalysisTypes.map((c, i) => (
                            <span key={i} style={categoryPill}>
                                {c.category} · {c.count}
                            </span>
                        ))}
                    </Section>
                </>
            ) : null}

            {showRanking ? (
                <Section style={rankingHero}>
                    <Text style={rankBadge}>
                        {tier.emoji} {tier.label}
                    </Text>
                    <Text style={rankNumber}>#{fmtNum(companyRank)}</Text>
                    <Text style={rankSubtitle}>
                        Your rank in the Kodus network this week
                    </Text>
                    <div style={rankBarTrack}>
                        <span style={rankBarFill(companyRankBarFill)} />
                    </div>
                </Section>
            ) : null}

            <Section style={{ margin: '28px 0 0' }}>
                <Button href={cockpitLink} style={baseButton}>
                    Open the Cockpit →
                </Button>
            </Section>
        </BrandLayout>
    );
}

WeeklyRecapEmail.PreviewProps = {
    devName: 'Sam',
    company: 'Acme Inc',
    startDate: '2026-04-19',
    endDate: '2026-04-25',
    numPRs: 42,
    reviewedPRs: 42,
    kodySuggestions: 188,
    suggestionsApplied: 73,
    criticalIssues: 6,
    bugRatio: 0.12,
    bugRatioTrend: 'improved',
    bugRatioChangePct: -18,
    deployFrequency: 18,
    deployFrequencyTrend: 'improved',
    deployFrequencyChangePct: 22,
    prCycleTime: 9.4,
    prCycleTimeTrend: 'improved',
    prCycleTimeChangePct: -12,
    reviewTime: 2.1,
    topContributorName: 'Sam Carter',
    topContributorPRs: 12,
    companyRank: 5,
    companyRankPercentile: 4.2,
    companyRankBarFill: 96,
    showRanking: true,
    topAnalysisTypes: [
        { category: 'Code quality', count: 64 },
        { category: 'Security', count: 31 },
        { category: 'Performance', count: 22 },
    ],
    cockpitLink: 'https://app.kodus.io/cockpit',
} satisfies WeeklyRecapEmailProps;

export default WeeklyRecapEmail;
