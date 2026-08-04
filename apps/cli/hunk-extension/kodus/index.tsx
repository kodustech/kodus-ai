/**
 * Kodus findings sidebar for Hunk.
 *
 * Loaded by `kodus review` with `--extension <this folder>` whenever it hands a
 * review off to the hunk TUI. Findings arrive out-of-band through the
 * `KODUS_HUNK_FINDINGS` env var — a JSON sidecar written by the CLI — because
 * hunk's own `--agent-context` schema flattens severity into a glyph inside the
 * note text, and this pane needs it back as data.
 *
 * The inline notes hunk already renders answer "what is wrong with this line?".
 * This pane answers what a file-ordered diff cannot: "what are the worst things
 * in this changeset, and where are they?" — so it sorts by severity, not path.
 *
 * NOTE: shipped as source and executed by hunk's own runtime. It lives outside
 * `src/` so our `tsc` never compiles it. React is served by hunk at import
 * time — never bundle or vendor a copy.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { ScrollBoxRenderable } from '@opentui/core';
import type {
    ExtensionCommandContext,
    ExtensionDiffFile,
    ExtensionSidebarViewProps,
    HunkExtensionAPI,
} from 'hunkdiff/extension';
import {
    SEVERITY_GLYPH,
    SEVERITY_ORDER,
    countBySeverity,
    findFile,
    findHunkIndex,
    orderFindings,
    parseFindings,
    shortenPath,
    type KodusFinding,
    type KodusFindings,
    type KodusSeverity,
} from './findings.js';

const VIEW_ID = 'findings';

/**
 * Read the sidecar. A missing or malformed file is not worth failing a review
 * over — the pane just reports it has nothing.
 */
function loadFindings(): KodusFindings {
    const sidecarPath = process.env.KODUS_HUNK_FINDINGS;
    if (!sidecarPath) {
        return { version: 1, findings: [] };
    }

    try {
        const { readFileSync } = require('node:fs') as typeof import('node:fs');
        return parseFindings(JSON.parse(readFileSync(sidecarPath, 'utf-8')));
    } catch {
        return { version: 1, findings: [] };
    }
}

function severityColor(
    severity: KodusSeverity,
    theme: ExtensionSidebarViewProps['theme'],
): string {
    switch (severity) {
        case 'critical':
        case 'error':
            return theme.badgeRemoved;
        case 'warning':
            return theme.accent;
        default:
            return theme.muted;
    }
}

interface ResolvedFinding {
    finding: KodusFinding;
    file: ExtensionDiffFile | undefined;
    hunkIndex: number | null;
}

function resolveFindings(
    findings: readonly KodusFinding[],
    files: ExtensionDiffFile[],
): ResolvedFinding[] {
    return findings.map((finding) => {
        const file = findFile(files, finding.file);
        return {
            finding,
            file,
            hunkIndex: file ? findHunkIndex(file, finding) : null,
        };
    });
}

function KodusFindingsSidebar({
    files,
    selectedFileId,
    selectedHunkIndex,
    width,
    theme,
    actions,
}: ExtensionSidebarViewProps) {
    const ordered = useMemo(() => orderFindings(loadFindings().findings), []);
    const resolved = useMemo(
        () => resolveFindings(ordered, files),
        [ordered, files],
    );
    const counts = useMemo(() => countBySeverity(ordered), [ordered]);
    const scrollRef = useRef<ScrollBoxRenderable | null>(null);

    // Follow the review stream: when the user navigates with the keyboard, keep
    // the matching finding visible instead of making them hunt for it.
    useEffect(() => {
        if (!selectedFileId) {
            return;
        }
        const match = resolved.find(
            (entry) =>
                entry.file?.id === selectedFileId &&
                (selectedHunkIndex === null ||
                    entry.hunkIndex === selectedHunkIndex),
        );
        if (match) {
            scrollRef.current?.scrollChildIntoView(`row-${match.finding.id}`);
        }
    }, [selectedFileId, selectedHunkIndex, resolved]);

    const headline =
        ordered.length === 0
            ? ' Kodus · no findings'
            : ` Kodus · ${ordered.length} finding${ordered.length === 1 ? '' : 's'}`;

    const breakdown = SEVERITY_ORDER.filter((severity) => counts[severity])
        .map((severity) => `${SEVERITY_GLYPH[severity]}${counts[severity]}`)
        .join('  ');

    // Leave room for the leading glyph column and the `:123` line suffix.
    const pathBudget = Math.max(12, width - 12);

    return (
        <scrollbox
            ref={scrollRef}
            width="100%"
            height="100%"
            focused={false}
            scrollY={true}
            rootOptions={{ backgroundColor: theme.panel }}
            wrapperOptions={{ backgroundColor: theme.panel }}
            viewportOptions={{ backgroundColor: theme.panel }}
            contentOptions={{ backgroundColor: theme.panel }}
            verticalScrollbarOptions={{ visible: false }}
            horizontalScrollbarOptions={{ visible: false }}
        >
            <box
                style={{
                    width: '100%',
                    flexDirection: 'column',
                    backgroundColor: theme.panel,
                }}
            >
                <text
                    content={headline}
                    style={{ fg: theme.accent, bg: theme.panel }}
                />
                {breakdown ? (
                    <text
                        content={` ${breakdown}`}
                        style={{ fg: theme.muted, bg: theme.panel }}
                    />
                ) : null}
                {ordered.length === 0 ? (
                    <text
                        content=" Nothing to review here."
                        style={{ fg: theme.muted, bg: theme.panel }}
                    />
                ) : null}
                {resolved.map(({ finding, file, hunkIndex }) => {
                    const selected =
                        file?.id === selectedFileId &&
                        hunkIndex === selectedHunkIndex;
                    const background = selected
                        ? theme.selectedHunk
                        : theme.panel;
                    const reachable = Boolean(file);

                    return (
                        <box
                            key={finding.id}
                            id={`row-${finding.id}`}
                            style={{
                                width: '100%',
                                flexDirection: 'column',
                                backgroundColor: background,
                            }}
                            onMouseDown={() => {
                                if (!file) {
                                    actions.notify(
                                        `${finding.file} is not in this review`,
                                        'warning',
                                    );
                                    return;
                                }
                                if (hunkIndex === null) {
                                    actions.selectFile(file.id);
                                } else {
                                    actions.selectHunk(file.id, hunkIndex);
                                }
                            }}
                        >
                            <text
                                content={` ${SEVERITY_GLYPH[finding.severity]} ${shortenPath(finding.file, pathBudget)}:${finding.line}`}
                                style={{
                                    fg: reachable
                                        ? severityColor(finding.severity, theme)
                                        : theme.muted,
                                    bg: background,
                                }}
                            />
                            <text
                                content={`   ${finding.title}`}
                                style={{
                                    fg: reachable ? theme.text : theme.muted,
                                    bg: background,
                                }}
                            />
                        </box>
                    );
                })}
            </box>
        </scrollbox>
    );
}

export default function registerKodusFindings(hunk: HunkExtensionAPI): void {
    const ordered = orderFindings(loadFindings().findings);

    // Sidebar components get `files` as a prop; command handlers don't, so the
    // changeset is mirrored here from the lifecycle events instead.
    let visibleFiles: ExtensionDiffFile[] = [];
    // Severity-first cursor. Deliberately not the same walk as hunk's `}`
    // (next *annotated* hunk, in document order): a critical three files down
    // should come before an info in the current file.
    let cursor = -1;

    hunk.registerSidebarView({
        id: VIEW_ID,
        title: 'Kodus findings',
        placement: 'right',
        // Only claim a pane when there is something to show; an empty panel
        // stealing width from the diff is worse than no panel.
        defaultOpen: ordered.length > 0,
        component: KodusFindingsSidebar,
    });

    // Hunk drops the entire sidebar area — the built-in file navigation
    // included — below roughly 220 columns, and no registered view can reopen
    // it (`replacesDefault` doesn't lower the threshold; neither does `--mode`).
    // On a normal-width terminal the findings would therefore be invisible with
    // no hint that they exist, so announce them with a toast, which renders
    // over the review regardless of pane layout.
    hunk.on('startup', (_event, ctx) => {
        if (ordered.length === 0) {
            return;
        }
        const counts = countBySeverity(ordered);
        const breakdown = SEVERITY_ORDER.filter((severity) => counts[severity])
            .map((severity) => `${SEVERITY_GLYPH[severity]}${counts[severity]}`)
            .join(' ');
        ctx.notify(
            `Kodus · ${ordered.length} finding${ordered.length === 1 ? '' : 's'} ${breakdown} · y panel · n/p next`,
        );
    });

    hunk.on('changeset_loaded', ({ changeset }) => {
        visibleFiles = changeset.files;
    });
    hunk.on('session_reload', ({ changeset }) => {
        visibleFiles = changeset.files;
        cursor = -1;
    });

    // `defaultOpen` marks the view open, but hunk drops the whole sidebar
    // *area* on narrow terminals (or wide diffs) — and an extension cannot ask
    // whether the area is visible. Toggling in that state would close a pane
    // the user never saw, so the first press always opens: `sidebars.open`
    // reveals the area too. Afterwards it toggles normally.
    let revealed = false;
    const reveal = (ctx: ExtensionCommandContext) => {
        ctx.sidebars.open(VIEW_ID);
        revealed = true;
    };

    hunk.registerCommand(
        { id: 'toggle', title: 'Toggle Kodus findings', key: 'y' },
        (ctx) => {
            if (!revealed) {
                reveal(ctx);
                return;
            }
            ctx.sidebars.toggle(VIEW_ID);
        },
    );

    const step = (delta: number) => (ctx: ExtensionCommandContext) => {
        if (ordered.length === 0) {
            ctx.notify('No Kodus findings in this review');
            return;
        }

        cursor = (cursor + delta + ordered.length) % ordered.length;
        const finding = ordered[cursor];

        reveal(ctx);

        const file = findFile(visibleFiles, finding.file);
        if (!file) {
            ctx.notify(
                `${finding.file}:${finding.line} is not in this review`,
                'warning',
            );
            return;
        }

        const hunkIndex = findHunkIndex(file, finding);
        if (hunkIndex === null) {
            ctx.navigation.selectFile(file.id);
        } else {
            ctx.navigation.selectHunk(file.id, hunkIndex);
        }

        ctx.notify(
            `${SEVERITY_GLYPH[finding.severity]} ${cursor + 1}/${ordered.length} · ${finding.title}`,
        );
    };

    hunk.registerCommand(
        { id: 'next', title: 'Next Kodus finding', key: 'n' },
        step(1),
    );
    hunk.registerCommand(
        { id: 'previous', title: 'Previous Kodus finding', key: 'p' },
        step(-1),
    );
}
