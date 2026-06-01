import boxen from 'boxen';
import chalk from 'chalk';
import figlet from 'figlet';
import gradient from 'gradient-string';
import { createRequire } from 'node:module';
import { getAuthModeSummary } from './auth-mode.js';
import { cliInfo } from './logger.js';
import { getRecentActivityLines } from './recent-activity.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

const THEME = {
    card: '#30304B',
    cardStrong: '#44446A',
    textMuted: '#CDCDDF',
    primary: '#F8B76D',
    secondary: '#C9BBF2',
};
const LOGO_GRADIENT = gradient(['#6A57A4', '#EF4C4B', '#F59220']);

function truncateLine(value: string, maxWidth: number): string {
    if (value.length <= maxWidth) {
        return value;
    }
    if (maxWidth <= 1) {
        return value.slice(0, maxWidth);
    }
    if (maxWidth <= 3) {
        return value.slice(0, maxWidth);
    }
    return `${value.slice(0, maxWidth - 3)}...`;
}

function makeTwoColumnRows(
    left: string[],
    right: string[],
    totalWidth: number,
    leftRatio = 0.42,
): string[] {
    const separator = '  |  ';
    const leftWidth = Math.max(
        20,
        Math.floor((totalWidth - separator.length) * leftRatio),
    );
    const rightWidth = Math.max(20, totalWidth - separator.length - leftWidth);
    const rowCount = Math.max(left.length, right.length);
    const rows: string[] = [];

    for (let i = 0; i < rowCount; i += 1) {
        const leftText = truncateLine(left[i] ?? '', leftWidth);
        const rightText = truncateLine(right[i] ?? '', rightWidth);
        rows.push(
            `${leftText.padEnd(leftWidth)}${separator}${rightText.padEnd(rightWidth)}`,
        );
    }

    return rows;
}

function styleOverviewStandaloneLine(
    line: string,
    logoLines: string[],
): string {
    if (logoLines.includes(line)) {
        return LOGO_GRADIENT(line);
    }
    if (
        line === 'Quick Start' ||
        line === 'Recent Activity' ||
        line === 'Common Commands'
    ) {
        return chalk.bold.hex(THEME.secondary)(line);
    }
    if (
        line.startsWith('Use these commands') ||
        line.startsWith('Use the most frequent')
    ) {
        return chalk.hex(THEME.textMuted)(line);
    }
    if (line.startsWith('────────────────')) {
        return chalk.hex(THEME.card)(line);
    }
    if (/^\d\)\s/.test(line)) {
        const sepIndex = line.indexOf(' - ');
        if (sepIndex === -1) {
            return chalk.hex(THEME.primary)(line);
        }
        const command = line.slice(0, sepIndex);
        const details = line.slice(sepIndex);
        return `${chalk.hex(THEME.primary)(command)}${chalk.hex(THEME.textMuted)(details)}`;
    }
    if (line.startsWith('kodus ')) {
        const sepIndex = line.indexOf(' - ');
        if (sepIndex === -1) {
            return chalk.hex(THEME.secondary)(line);
        }
        const command = line.slice(0, sepIndex);
        const details = line.slice(sepIndex);
        return `${chalk.hex(THEME.secondary)(command)}${chalk.hex(THEME.textMuted)(details)}`;
    }
    if (line.startsWith('Auth Mode:')) {
        return line.replace(/^([^:]+:)/, (_full, label) =>
            chalk.hex(THEME.secondary)(label),
        );
    }
    if (line.startsWith('No recent activity yet')) {
        return chalk.hex(THEME.textMuted)(line);
    }
    return line;
}

function styleOverviewRow(row: string, logoLines: string[]): string {
    let styled = row.replace('  |  ', `  ${chalk.hex(THEME.secondary)('|')}  `);
    styled = styled.replace(
        'Quick Start',
        chalk.bold.hex(THEME.secondary)('Quick Start'),
    );
    styled = styled.replace(
        'Common Commands',
        chalk.bold.hex(THEME.secondary)('Common Commands'),
    );
    styled = styled.replace(
        'Recent Activity',
        chalk.bold.hex(THEME.secondary)('Recent Activity'),
    );
    styled = styled.replace(
        'Use these commands to get started quickly:',
        chalk.hex(THEME.textMuted)(
            'Use these commands to get started quickly:',
        ),
    );
    styled = styled.replace(
        'Use the most frequent commands:',
        chalk.hex(THEME.textMuted)('Use the most frequent commands:'),
    );
    if (styled.includes('No recent activity yet')) {
        styled = styled.replace(
            'No recent activity yet',
            chalk.hex(THEME.textMuted)('No recent activity yet'),
        );
    }
    styled = styled.replace(
        '──────────────────────────────',
        chalk.hex(THEME.card)('──────────────────────────────'),
    );
    styled = styled.replace(/(Auth Mode:)/g, (label) =>
        chalk.hex(THEME.secondary)(label),
    );

    for (const logoLine of logoLines) {
        if (styled.includes(logoLine)) {
            styled = styled.replace(logoLine, LOGO_GRADIENT(logoLine));
        }
    }

    styled = styled.replace(
        /\b(kodus [^|]+?)(\s+-\s+[^|]+)?(?=\s*$|\s{2,})/g,
        (_full, cmd, desc = '') => {
            if (!cmd.startsWith('kodus ')) {
                return _full;
            }
            return `${chalk.hex(THEME.secondary)(cmd)}${chalk.hex(THEME.textMuted)(desc)}`;
        },
    );

    return styled;
}

function renderLogoLines(terminalWidth: number): string[] {
    const font = terminalWidth >= 100 ? 'Small' : 'Mini';

    try {
        const logo = figlet.textSync('KODUS', {
            font,
            width: Math.min(terminalWidth, 80),
            horizontalLayout: 'fitted',
            verticalLayout: 'default',
        });
        return logo.split('\n').filter((line) => line.trim().length > 0);
    } catch {
        return ['KODUS'];
    }
}

export async function showBanner() {
    const envColumns = Number.parseInt(process.env.COLUMNS ?? '', 10);
    const terminalWidth =
        process.stdout.columns ??
        (Number.isFinite(envColumns) && envColumns > 0 ? envColumns : 110);
    const contentWidth = Math.min(Math.max(terminalWidth - 8, 64), 160);
    const compactLayout = terminalWidth < 90;
    const logoLines = renderLogoLines(terminalWidth);
    const authMode = await getAuthModeSummary().then((summary) => summary.label);
    const recentActivityLines = await getRecentActivityLines(2);

    const leftOverviewLines: string[] = [
        ...logoLines,
        `Auth Mode: ${authMode}`,
        '',
        'Quick Start',
        'Use these commands to get started quickly:',
        '',
        '1) kodus review --fast - quick local analysis',
        '2) kodus auth login - connect your account',
        '3) kodus pr suggestions - fetch PR suggestions',
        '4) kodus status - check auth/hooks/skills',
        '5) kodus --help - list all commands',
    ];

    const rightOverviewLines = [
        'Common Commands',
        'Use the most frequent commands:',
        '',
        'kodus review --fast - quick local review',
        'kodus review --fix - auto-apply fixable suggestions',
        'kodus pr suggestions - fetch PR suggestions',
        'kodus pr business-validation - run business validation',
        'kodus auth status - check current auth mode',
        'kodus hook install - install pre-push review hook',
        'kodus skills list - list bundled skills',
        'kodus skills resync - re-sync bundled skills',
        'kodus update - update Kodus CLI version',
        'kodus --help - see all commands and options',
        '',
        '──────────────────────────────',
        '',
        'Recent Activity',
        ...recentActivityLines,
    ];
    const overviewLines = compactLayout
        ? [...leftOverviewLines, '', ...rightOverviewLines].map((line) =>
              styleOverviewStandaloneLine(line, logoLines),
          )
        : makeTwoColumnRows(
              leftOverviewLines,
              rightOverviewLines,
              contentWidth - 4,
              0.42,
          ).map((line) => styleOverviewRow(line, logoLines));

    const dashboard = boxen(overviewLines.join('\n'), {
        padding: { top: 0, bottom: 0, left: 1, right: 1 },
        borderStyle: 'bold',
        borderColor: THEME.cardStrong,
        title: `${chalk.bold.hex(THEME.primary)('Kodus CLI')} ${chalk.hex(THEME.textMuted)(`v${pkg.version}`)}`,
        titleAlignment: 'left',
    });

    cliInfo(dashboard);
}
