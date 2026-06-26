import * as React from 'react';
import { Column, Row, Section, Text } from 'react-email';

/**
 * Shared styling + formatting primitives for the actionable review reports
 * (repo digest + org report). Kept brand-aligned with the rest of the Kodus
 * email system: peach (#f8b76d) + brown (#443024), status red (#fa5867) /
 * green (#42be65).
 */

export type Trend = 'improved' | 'worsened' | 'unchanged';

export type Accent = {
    bg: string;
    border: string;
    valueColor: string;
    labelColor: string;
};

export const ACCENTS: Record<'peach' | 'red' | 'green' | 'neutral', Accent> = {
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
    green: {
        bg: '#E6F6EC',
        border: '#BFE6CC',
        valueColor: '#13532B',
        labelColor: '#1F7A47',
    },
    neutral: {
        bg: '#F9FAFB',
        border: '#E5E7EB',
        valueColor: '#443024',
        labelColor: '#6B7280',
    },
};

export const cardBase = (a: Accent): React.CSSProperties => ({
    backgroundColor: a.bg,
    border: `1px solid ${a.border}`,
    borderRadius: 8,
    // Floor so paired cards never look ragged across clients that honour it;
    // the reserved trend slot handles the rest (incl. Outlook).
    minHeight: 96,
    margin: 0,
    padding: '14px 16px',
});

export const statValueBase = (a: Accent): React.CSSProperties => ({
    color: a.valueColor,
    fontSize: 24,
    fontWeight: 700,
    lineHeight: '30px',
    margin: 0,
});

export const statLabelBase = (a: Accent): React.CSSProperties => ({
    color: a.labelColor,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: '0.04em',
    lineHeight: '16px',
    margin: '4px 0 0',
    textTransform: 'uppercase',
});

export const sectionHeading: React.CSSProperties = {
    color: '#111827',
    fontSize: 16,
    fontWeight: 600,
    lineHeight: '22px',
    margin: '28px 0 10px',
};

export const sectionSubhead: React.CSSProperties = {
    color: '#6B7280',
    fontSize: 13,
    lineHeight: '18px',
    margin: '0 0 14px',
};

export const tableRow: React.CSSProperties = {
    borderBottom: '1px solid #F3F4F6',
    padding: '12px 0',
};

export const tableLabel: React.CSSProperties = {
    color: '#374151',
    fontSize: 14,
    lineHeight: '20px',
    margin: 0,
};

export const tableValue: React.CSSProperties = {
    color: '#111827',
    fontSize: 15,
    fontWeight: 700,
    lineHeight: '22px',
    margin: 0,
    textAlign: 'right',
};

const trendChipBase: React.CSSProperties = {
    borderRadius: 999,
    display: 'inline-block',
    fontSize: 11,
    fontWeight: 600,
    lineHeight: '14px',
    margin: '8px 0 0',
    padding: '3px 9px',
};

const trendUp: React.CSSProperties = {
    ...trendChipBase,
    backgroundColor: '#E6F6EC',
    color: '#1F7A47',
};
const trendDown: React.CSSProperties = {
    ...trendChipBase,
    backgroundColor: '#FEE7E7',
    color: '#B12A30',
};
const trendFlat: React.CSSProperties = {
    ...trendChipBase,
    backgroundColor: '#F3F4F6',
    color: '#6B7280',
};

// Invisible chip with the exact same box as a real trend pill — keeps paired
// cards equal height when one has no trend to show.
const trendSpacer: React.CSSProperties = {
    ...trendChipBase,
    backgroundColor: 'transparent',
    color: 'transparent',
};

export const headlineHero: React.CSSProperties = {
    backgroundColor: '#FEF3E2',
    border: '1px solid #f8b76d',
    borderRadius: 12,
    margin: '20px 0 8px',
    padding: '20px 22px',
};

export const headlineKicker: React.CSSProperties = {
    color: '#92571F',
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: '0.06em',
    lineHeight: '16px',
    margin: 0,
    textTransform: 'uppercase',
};

export const headlineValue: React.CSSProperties = {
    color: '#443024',
    fontSize: 34,
    fontWeight: 800,
    lineHeight: '40px',
    margin: '4px 0 4px',
};

export const headlineCaption: React.CSSProperties = {
    color: '#6B5644',
    fontSize: 14,
    lineHeight: '20px',
    margin: 0,
};

export const repoSectionWrap: React.CSSProperties = {
    border: '1px solid #EFE6DC',
    borderRadius: 12,
    margin: '16px 0 0',
    padding: '18px 20px',
};

export const repoSectionTitle: React.CSSProperties = {
    color: '#443024',
    fontSize: 17,
    fontWeight: 700,
    lineHeight: '24px',
    margin: '0 0 2px',
    wordBreak: 'break-all',
};

const barTrack: React.CSSProperties = {
    backgroundColor: '#F1EEEA',
    borderRadius: 6,
    height: 12,
    overflow: 'hidden',
    width: '100%',
};

const barLabel: React.CSSProperties = {
    color: '#6B7280',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.04em',
    lineHeight: '14px',
    margin: 0,
    textTransform: 'uppercase',
};

const barValue: React.CSSProperties = {
    color: '#443024',
    fontSize: 14,
    fontWeight: 700,
    lineHeight: '18px',
    margin: 0,
    textAlign: 'right',
};

export function StatCard({
    label,
    value,
    accent,
    icon,
    sub,
}: {
    label: string;
    value: string;
    accent: keyof typeof ACCENTS;
    icon?: string;
    sub?: { style: React.CSSProperties; text: string } | null;
}) {
    const a = ACCENTS[accent];
    return (
        <Section style={cardBase(a)}>
            <Text style={statValueBase(a)}>{value}</Text>
            <Text style={statLabelBase(a)}>
                {icon ? `${icon} ` : ''}
                {label}
            </Text>
            {/* Always reserve the trend slot so paired cards keep equal
                height whether or not they carry a trend. */}
            {sub ? (
                <Text style={sub.style}>{sub.text}</Text>
            ) : (
                <Text style={trendSpacer}>&nbsp;</Text>
            )}
        </Section>
    );
}

export function StatPair({
    left,
    right,
}: {
    left: React.ComponentProps<typeof StatCard>;
    right: React.ComponentProps<typeof StatCard>;
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

/** A horizontal bar (0..1 fill) with a label and value, e.g. weekly trend. */
export function BarRow({
    label,
    value,
    fill,
    color = '#f8b76d',
}: {
    label: string;
    value: string;
    fill: number; // 0..1
    color?: string;
}) {
    return (
        <Row style={{ margin: '0 0 10px' }}>
            <Column style={{ verticalAlign: 'middle', width: '16%' }}>
                <Text style={barLabel}>{label}</Text>
            </Column>
            <Column style={{ verticalAlign: 'middle', width: '62%' }}>
                <div style={barTrack}>
                    <span
                        style={{
                            backgroundColor: color,
                            borderRadius: 6,
                            display: 'block',
                            height: 12,
                            width: `${Math.max(
                                3,
                                Math.min(fill * 100, 100),
                            )}%`,
                        }}
                    />
                </div>
            </Column>
            <Column
                style={{
                    paddingLeft: 8,
                    verticalAlign: 'middle',
                    width: '22%',
                }}
            >
                <Text style={barValue}>{value}</Text>
            </Column>
        </Row>
    );
}

export function trendBadge(
    trend: Trend,
    changePct: number,
    direction: 'up-good' | 'down-good',
): { style: React.CSSProperties; text: string } | null {
    if (trend === 'unchanged' || !Number.isFinite(changePct)) {
        return { style: trendFlat, text: '— flat vs last period' };
    }
    const isGood = trend === 'improved';
    // Arrow follows the actual value movement; colour follows good/bad. For a
    // down-good metric (e.g. cycle time) an improvement means the value FELL,
    // so it reads "↘" in green — not "↗".
    const valueWentUp = (direction === 'up-good') === isGood;
    const arrow = valueWentUp ? '↗' : '↘';
    const abs = Math.abs(changePct).toFixed(0);
    return {
        style: isGood ? trendUp : trendDown,
        text: `${arrow} ${abs}% vs last period`,
    };
}

export function ppBadge(
    trend: Trend,
    ppChange: number,
): { style: React.CSSProperties; text: string } {
    if (trend === 'unchanged' || !Number.isFinite(ppChange) || ppChange === 0) {
        return { style: trendFlat, text: '— flat vs last period' };
    }
    const isGood = trend === 'improved';
    const arrow = isGood ? '↗' : '↘';
    const abs = Math.abs(ppChange).toFixed(0);
    return {
        style: isGood ? trendUp : trendDown,
        text: `${arrow} ${abs}pp vs last period`,
    };
}

export function fmtNum(n: number, digits = 0): string {
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString('en-US', {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
    });
}

export function fmtHours(h: number): string {
    if (!Number.isFinite(h) || h <= 0) return '—';
    if (h < 1) return `${Math.round(h * 60)}m`;
    if (h < 24) return `${h.toFixed(1)}h`;
    return `${(h / 24).toFixed(1)}d`;
}

/** Rate is 0..1; rendered as a whole-number percent. */
export function fmtRate(rate: number): string {
    if (!Number.isFinite(rate)) return '—';
    return `${Math.round(rate * 100)}%`;
}

export function fmtDateRange(start: string, end: string): string {
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

/**
 * Long month name for a YYYY-MM-DD date, e.g. "June". UTC-pinned. Returns ''
 * for missing/invalid input so callers can drop the segment cleanly instead
 * of printing "Invalid Date".
 */
export function fmtMonth(dateStr: string): string {
    const d = new Date(`${dateStr}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
}

/**
 * Compact range, e.g. "Jun 1–15" (same month) or "Jun 25 – Jul 8". Returns ''
 * for missing/invalid input (never "Invalid Date NaN–NaN").
 */
export function fmtCompactRange(start: string, end: string): string {
    const s = new Date(`${start}T00:00:00Z`);
    const e = new Date(`${end}T00:00:00Z`);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return '';
    const opts: Intl.DateTimeFormatOptions = {
        month: 'short',
        timeZone: 'UTC',
    };
    const sMon = s.toLocaleDateString('en-US', opts);
    const eMon = e.toLocaleDateString('en-US', opts);
    const sDay = s.getUTCDate();
    const eDay = e.getUTCDate();
    return sMon === eMon
        ? `${sMon} ${sDay}–${eDay}`
        : `${sMon} ${sDay} – ${eMon} ${eDay}`;
}

/** Last path segment of `org/repo` for compact display. */
export function repoShortName(fullName: string): string {
    const parts = fullName.split('/');
    return parts[parts.length - 1] || fullName;
}

/** "performance_and_optimization" → "Performance and optimization". */
export function humanizeCategory(label: string): string {
    if (!label) return 'Uncategorized';
    const spaced = label.replace(/_/g, ' ').trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export type RuleState =
    | 'healthy'
    | 'noisy'
    | 'ignored'
    | 'low_data'
    | 'stale';

const STATE_META: Record<
    RuleState,
    { label: string; bg: string; color: string }
> = {
    noisy: { label: 'Noisy', bg: '#FEE7E7', color: '#B12A30' },
    ignored: { label: 'Ignored', bg: '#FEF3E2', color: '#92571F' },
    low_data: { label: 'Low data', bg: '#F3F4F6', color: '#6B7280' },
    healthy: { label: 'Healthy', bg: '#E6F6EC', color: '#1F7A47' },
    stale: { label: 'Stale', bg: '#F3F4F6', color: '#6B7280' },
};

const ruleRowStyle: React.CSSProperties = {
    borderBottom: '1px solid #F3F4F6',
    padding: '11px 0',
};

const ruleTitleStyle: React.CSSProperties = {
    color: '#374151',
    fontSize: 14,
    fontWeight: 600,
    lineHeight: '19px',
    margin: 0,
};

const ruleMetaStyle: React.CSSProperties = {
    color: '#6B7280',
    fontSize: 12,
    lineHeight: '16px',
    margin: '2px 0 0',
};

export function StateChip({ state }: { state: RuleState }) {
    const m = STATE_META[state] ?? STATE_META.healthy;
    return (
        <span
            style={{
                backgroundColor: m.bg,
                borderRadius: 999,
                color: m.color,
                display: 'inline-block',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.04em',
                padding: '2px 8px',
                textTransform: 'uppercase',
            }}
        >
            {m.label}
        </span>
    );
}

/** A row in a rule-health table: title + state chip + a small meta line. */
export function RuleRow({
    title,
    state,
    detail,
}: {
    title: string;
    state: RuleState;
    detail: string;
}) {
    return (
        <Row style={ruleRowStyle}>
            <Column style={{ verticalAlign: 'top' }}>
                <Text style={ruleTitleStyle}>{title}</Text>
                <Text style={ruleMetaStyle}>{detail}</Text>
            </Column>
            <Column
                style={{
                    textAlign: 'right',
                    verticalAlign: 'top',
                    whiteSpace: 'nowrap',
                    width: 84,
                }}
            >
                <StateChip state={state} />
            </Column>
        </Row>
    );
}
