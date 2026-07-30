/**
 * Publishes the public changelog entry for a self-hosted release tag.
 *
 * Triggered by `.github/workflows/changelog-publish.yml` on push of a
 * `selfhosted-X.Y.Z` tag. Cloud and self-hosted typically ship the
 * same features within a short window — publishing once per
 * self-hosted release is enough to cover both audiences without
 * duplicating entries.
 *
 * The release entry has TWO sources of content:
 *
 *   1. Lifecycle promotions from `release/features.yaml` — features
 *      that flipped to `beta` or `general-availability` between the
 *      previous tag and this one. Rich LLM-written copy.
 *
 *   2. PR / commit summary from `git log` between the two tags —
 *      `feat`, `fix`, `perf` Conventional Commits become bullet
 *      points under "Improvements" and "Bug fixes". Mechanical, no
 *      LLM. `chore`, `ci`, `refactor`, `test`, `docs`, `style`,
 *      `build` are filtered out as internal-only.
 *
 * `features.yaml` is the gating catalog, NOT the release log. Most
 * shipped changes (bug fixes, polish, improvements that don't get
 * gated) reach the changelog via commits — exactly like the legacy
 * `.github/workflows/changelog.yml` did.
 *
 * Required GitHub secrets:
 *   GEMINI_API_KEY                Google AI API key for headline copy
 *                                 (or API_GOOGLE_AI_API_KEY — script
 *                                 picks whichever is set).
 *   DISCORD_WEBHOOK_COMMUNITY     customer-facing #releases
 *                                 channel in the Kodus community
 *                                 Discord. Falls back to
 *                                 DISCORD_WEBHOOK_SELFHOSTED (historical
 *                                 channel that received this content
 *                                 before) and DISCORD_WEBHOOK (legacy
 *                                 general). The script picks the first
 *                                 that's set.
 *
 * Usage:
 *   pnpm run feature-gate:changelog --tag <release-tag>
 *
 *   --tag <name>   The release tag this run is publishing for. Workflow
 *                  passes `selfhosted-*` only; running locally with
 *                  `web-*` or `v*` is supported for ad-hoc tests but
 *                  the workflow won't auto-publish those.
 *   --dry-run      Don't write MDX, don't call Discord. Print plan.
 */

import { execSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

import yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '../..');
const YAML_PATH = 'release/features.yaml';
const VOICE_PATH = 'release/voice.md';
const CHANGELOG_DIR = resolve(REPO_ROOT, 'docs/changelog');

type Stage = 'alpha' | 'beta' | 'general-availability';
type Audience = 'cloud' | 'self-hosted';

interface YamlFeature {
    name: string;
    stage: Stage;
    description?: string;
    documentation_url?: string;
    audience?: Audience[];
}

interface YamlCatalog {
    schema_version: number;
    features: Record<string, YamlFeature>;
}

interface Promotion {
    flagKey: string;
    name: string;
    fromStage: Stage | null;
    toStage: Stage;
    description: string;
    documentation_url?: string;
    audience?: Audience[];
}

const STAGE_RANK: Record<Stage, number> = {
    alpha: 0,
    beta: 1,
    'general-availability': 2,
};

function parseArgs(): {
    tag: string;
    dryRun: boolean;
} {
    const argv = process.argv.slice(2);
    const get = (flag: string): string | undefined => {
        const idx = argv.indexOf(flag);
        return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : undefined;
    };
    const tag = get('--tag');
    if (!tag) {
        console.error(
            'Missing required --tag <release-tag>. Example: --tag selfhosted-2.0.20',
        );
        process.exit(2);
    }
    return {
        tag,
        dryRun: argv.includes('--dry-run'),
    };
}

/**
 * Returns the regex of release tags belonging to the same "train" as the
 * supplied tag. Mirrors the resolution in `.github/workflows/changelog.yml`.
 *
 *   selfhosted-2.0.20  -> matches selfhosted-X.Y.Z
 *   web-1.4.0          -> matches web-X.Y.Z
 *   v1.4.0             -> matches vX.Y.Z
 *   1.4.0              -> matches X.Y.Z (legacy bare-semver tags)
 */
function tagTrainRegex(tag: string): RegExp {
    if (/^selfhosted-\d+\.\d+\.\d+$/.test(tag)) {
        return /^selfhosted-\d+\.\d+\.\d+$/;
    }
    if (/^web-\d+\.\d+\.\d+$/.test(tag)) {
        return /^web-\d+\.\d+\.\d+$/;
    }
    if (/^v\d+\.\d+\.\d+$/.test(tag)) {
        return /^v\d+\.\d+\.\d+$/;
    }
    return /^\d+\.\d+\.\d+$/;
}

/** "selfhosted" | "web" | "v" | "bare" — used for Discord routing & copy. */
function tagTrain(tag: string): 'selfhosted' | 'web' | 'v' | 'bare' {
    if (tag.startsWith('selfhosted-')) return 'selfhosted';
    if (tag.startsWith('web-')) return 'web';
    if (tag.startsWith('v')) return 'v';
    return 'bare';
}

function semverSort(tags: string[]): string[] {
    return tags.slice().sort((a, b) => {
        const numsA = a.match(/\d+/g)?.map(Number) ?? [];
        const numsB = b.match(/\d+/g)?.map(Number) ?? [];
        for (let i = 0; i < Math.max(numsA.length, numsB.length); i++) {
            const x = numsA[i] ?? 0;
            const y = numsB[i] ?? 0;
            if (x !== y) return x - y;
        }
        return 0;
    });
}

function findPreviousTag(currentTag: string): string | null {
    try {
        const out = execSync('git tag --list', {
            cwd: REPO_ROOT,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).toString();
        const regex = tagTrainRegex(currentTag);
        const sameTrain = out
            .split('\n')
            .map((t) => t.trim())
            .filter((t) => regex.test(t));
        const sorted = semverSort(sameTrain);
        const idx = sorted.indexOf(currentTag);
        if (idx <= 0) return null; // first tag of the train, or not found
        return sorted[idx - 1];
    } catch {
        return null;
    }
}

function loadYamlAtRef(ref: string | null): YamlCatalog | null {
    if (!ref) return null;
    try {
        const raw = execSync(`git show ${ref}:${YAML_PATH}`, {
            cwd: REPO_ROOT,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).toString();
        return yaml.load(raw) as YamlCatalog;
    } catch {
        return null;
    }
}

/**
 * Greps the codebase for the feature flag key and returns the file paths
 * that mention it. The LLM uses this to figure out which surfaces the
 * feature touches (CLI, dashboard, code-review engine, MCP, etc.) without
 * us having to maintain a manual surface taxonomy in the catalog.
 *
 * Filters down to the top-level app / lib directories so the prompt isn't
 * polluted with deep file paths — the LLM only needs the high-level
 * "where does this live in the repo" signal.
 */
function inferAffectedAreas(flagKey: string): string[] {
    // grep -rl over the working tree (catches uncommitted files too).
    // Restrict to apps/ and libs/ — top-level dirs that actually contain
    // user-facing surfaces. Skip the catalog itself so the feature key in
    // release/features.yaml doesn't become its own match.
    const escaped = flagKey.replace(/'/g, `'\\''`);
    try {
        const raw = execSync(
            `grep -rlI --include='*.ts' --include='*.tsx' --exclude-dir=node_modules --exclude-dir=dist -- '${escaped}' apps libs 2>/dev/null || true`,
            { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] },
        )
            .toString()
            .trim();
        if (!raw) return [];

        const tops = new Set<string>();
        for (const line of raw.split('\n')) {
            const parts = line.split('/');
            if (parts.length < 2) continue;
            // apps/web/src/... -> apps/web
            // libs/feature-gate/... -> libs/feature-gate
            tops.add(`${parts[0]}/${parts[1]}`);
        }
        return Array.from(tops).sort();
    } catch {
        return [];
    }
}

function diffPromotions(
    before: YamlCatalog | null,
    after: YamlCatalog | null,
): Promotion[] {
    if (!after) return [];
    const promotions: Promotion[] = [];

    for (const [flagKey, current] of Object.entries(after.features)) {
        const previous = before?.features[flagKey];
        const fromStage = previous?.stage ?? null;
        const toStage = current.stage;
        const movedForward =
            !previous ||
            STAGE_RANK[toStage] > STAGE_RANK[previous.stage];

        if (!movedForward) continue;
        // alpha is design-partner-only; beta + GA are the customer-facing
        // promotions that go into the public release entry.
        if (
            toStage !== 'alpha' &&
            toStage !== 'beta' &&
            toStage !== 'general-availability'
        ) {
            continue;
        }

        promotions.push({
            flagKey,
            name: current.name,
            fromStage,
            toStage,
            description: (current.description ?? '').trim(),
            documentation_url: current.documentation_url,
            audience: current.audience,
        });
    }

    return promotions;
}

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-3-flash-preview';

async function generateCopy(
    promotion: Promotion,
    voice: string,
): Promise<{ headline: string; body: string }> {
    const apiKey =
        process.env.GEMINI_API_KEY ?? process.env.API_GOOGLE_AI_API_KEY;
    if (!apiKey) {
        // No key in dev / smoke test — fall back to deterministic copy from
        // the catalog entry so the workflow still produces an MDX.
        const headline =
            promotion.toStage === 'general-availability'
                ? `${promotion.name} is now generally available`
                : `${promotion.name} is now in beta`;
        return { headline, body: promotion.description };
    }

    const affectedAreas = inferAffectedAreas(promotion.flagKey);
    const audienceLine =
        !promotion.audience || promotion.audience.length === 0
            ? 'Audience: cloud + self-hosted (default)'
            : `Audience: ${promotion.audience.join(' + ')}`;
    const prompt = [
        'You write the Kodus public changelog. Follow this voice guide strictly:',
        '',
        voice,
        '',
        'Draft a single changelog entry for the feature below. Output JSON only,',
        'shape: {"headline": "string", "body": "string"}. The body must be 2-4',
        'sentences, plain text, no markdown formatting. The headline appears',
        'verbatim in Mintlify and Discord. Do NOT mention "Cloud only" or',
        '"Self-hosted only" in the headline yourself — a badge is appended',
        'automatically based on the audience field. The body MAY mention',
        "where it's available if useful for the user (e.g. for self-hosted-only",
        "features, mention the BETA_FEATURES env var or upgrade path).",
        '',
        `Feature key: ${promotion.flagKey}`,
        `Display name: ${promotion.name}`,
        `Stage transition: ${promotion.fromStage ?? 'new'} -> ${promotion.toStage}`,
        audienceLine,
        `Description seed: ${promotion.description || '(none)'}`,
        promotion.documentation_url
            ? `Docs path: ${promotion.documentation_url}`
            : '',
        affectedAreas.length > 0
            ? [
                  '',
                  'Repository areas the feature touches (inferred from file paths):',
                  ...affectedAreas.map((a) => `  - ${a}`),
                  '',
                  'Use these to figure out the user-facing surface. Common mappings:',
                  '  apps/web -> dashboard / web app',
                  '  apps/cli -> Kodus CLI',
                  '  apps/mcp-manager -> MCP integration',
                  '  apps/api / apps/worker / apps/webhooks -> backend (often dashboard)',
                  '  libs/code-review -> the code review engine (cross-cutting)',
                  '  libs/cockpit -> Cockpit metrics',
                  'Frame the body with surface-appropriate language — e.g. CLI features',
                  'mention commands, dashboard features mention pages or settings.',
              ].join('\n')
            : '',
    ]
        .filter(Boolean)
        .join('\n');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                // Gemini 3 reserves part of the budget for internal
                // reasoning ("thinking") by default. For changelog copy
                // we don't need it — disable to leave the full budget
                // for the actual JSON response.
                thinkingConfig: { thinkingBudget: 0 },
                maxOutputTokens: 2048,
                temperature: 0.4,
                responseMimeType: 'application/json',
                responseSchema: {
                    type: 'object',
                    properties: {
                        headline: { type: 'string' },
                        body: { type: 'string' },
                    },
                    required: ['headline', 'body'],
                },
            },
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(
            `Gemini API ${response.status} ${response.statusText}: ${text}`,
        );
    }

    const json = (await response.json()) as {
        candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
        }>;
    };
    const text = (json.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('')
        .trim();

    if (!text) {
        throw new Error(
            `Gemini returned empty content. Full response:\n${JSON.stringify(json)}`,
        );
    }

    try {
        return JSON.parse(text) as { headline: string; body: string };
    } catch {
        // Defensive: if Gemini wraps JSON in prose, extract it.
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
            return JSON.parse(match[0]) as {
                headline: string;
                body: string;
            };
        }
        throw new Error(`Gemini returned non-JSON output:\n${text}`);
    }
}

function slugify(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

interface ReleaseEntryItem {
    promotion: Promotion;
    copy: { headline: string; body: string };
}

interface PRItem {
    number: number;
    title: string;
    type: 'feat' | 'fix' | 'perf';
    scope?: string;
    subject: string;
    breaking: boolean;
    headRefName?: string;
    url?: string;
    body?: string;
    polished?: string;
}

const USER_FACING_TYPES = new Set(['feat', 'fix', 'perf']);
const CC_PATTERN =
    /^(feat|fix|perf|docs|style|refactor|test|chore|ci|build)(\(([^)]+)\))?(!)?:\s*(.+)$/;

/**
 * Heuristic fallback: extracts a Conventional-Commits-shaped record from
 * a branch name like `feat/billing-export`, `fix/sso-redirect`, or
 * `bugfix/repo-path`. Only used when the PR title itself isn't
 * CC-shaped (legacy PRs predating `pr-title-check.yml`).
 */
function parseFromBranch(
    branch: string,
    fallbackSubject: string,
): { type: 'feat' | 'fix' | 'perf'; subject: string } | null {
    const match = branch.match(/^(feat|feature|fix|bugfix|perf)\//i);
    if (!match) return null;
    const raw = match[1].toLowerCase();
    const type =
        raw === 'feat' || raw === 'feature'
            ? 'feat'
            : raw === 'fix' || raw === 'bugfix'
              ? 'fix'
              : 'perf';
    return { type, subject: fallbackSubject };
}

/**
 * Lists every PR merged into `main` between two release tags by
 * querying GitHub for the timestamp window. The PR title is enforced
 * to follow Conventional Commits via `pr-title-check.yml`, so it's a
 * more reliable source for the release log than raw commit subjects.
 *
 * Falls back to an empty list if `gh` is unavailable / unauthenticated
 * — the script still runs against feature promotions only.
 */
function loadPRsBetweenTags(
    previousTag: string | null,
    currentTag: string,
): PRItem[] {
    if (!previousTag) return [];

    let prevDate = '';
    let currDate = '';
    try {
        prevDate = execSync(
            `git show -s --format=%cI ${previousTag}`,
            { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] },
        )
            .toString()
            .trim();
        currDate = execSync(`git show -s --format=%cI ${currentTag}`, {
            cwd: REPO_ROOT,
            stdio: ['ignore', 'pipe', 'ignore'],
        })
            .toString()
            .trim();
    } catch {
        return [];
    }

    let raw = '';
    try {
        raw = execSync(
            `gh pr list --base main --state merged ` +
                `--search "merged:${prevDate}..${currDate}" ` +
                `--limit 200 ` +
                `--json number,title,headRefName,url,mergedAt,body`,
            { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] },
        ).toString();
    } catch {
        console.warn(
            'gh CLI failed (not authenticated or offline). Skipping PR-based body.',
        );
        return [];
    }

    let prs: Array<{
        number: number;
        title: string;
        headRefName?: string;
        url?: string;
        mergedAt?: string;
        body?: string;
    }> = [];
    try {
        prs = JSON.parse(raw);
    } catch {
        return [];
    }

    const items: PRItem[] = [];
    for (const pr of prs) {
        const titleMatch = pr.title.match(CC_PATTERN);
        if (titleMatch) {
            const [, type, , scope, breaking, message] = titleMatch;
            if (!USER_FACING_TYPES.has(type)) continue;
            items.push({
                number: pr.number,
                title: pr.title,
                type: type as PRItem['type'],
                scope: scope || undefined,
                subject: message.trim(),
                breaking: breaking === '!',
                headRefName: pr.headRefName,
                url: pr.url,
                body: pr.body,
            });
            continue;
        }
        if (pr.headRefName) {
            const fromBranch = parseFromBranch(pr.headRefName, pr.title);
            if (fromBranch) {
                items.push({
                    number: pr.number,
                    title: pr.title,
                    type: fromBranch.type,
                    subject: fromBranch.subject.trim(),
                    breaking: false,
                    headRefName: pr.headRefName,
                    url: pr.url,
                    body: pr.body,
                });
            }
        }
    }

    return items;
}

function formatPRSubject(item: PRItem): string {
    const breakingMark = item.breaking ? ' ⚠️' : '';
    if (item.polished) {
        return `${item.polished}${breakingMark} (#${item.number})`;
    }
    const prefix = item.scope ? `**${item.scope}**: ` : '';
    const msg =
        item.subject.charAt(0).toUpperCase() + item.subject.slice(1);
    return `${prefix}${msg}${breakingMark} (#${item.number})`;
}

/**
 * Sends every user-facing PR through Gemini in a single batched call so
 * the Discord/Mintlify bullets read as polished user copy instead of raw
 * branch slugs (e.g. `Feat/self hosted telemetry` becomes "Self-hosted
 * deployments now report opt-in usage telemetry to help us prioritise
 * fixes."). Each item gets a single sentence following `voice.md`.
 *
 * Mutates the supplied PR list in place by setting `polished`. Falls
 * back to the mechanical formatter if the API key is missing or the
 * request fails — we never want a Gemini outage to block a release post.
 */
async function polishPRsWithGemini(
    prs: PRItem[],
    voice: string,
): Promise<void> {
    if (prs.length === 0) return;

    const apiKey =
        process.env.GEMINI_API_KEY ?? process.env.API_GOOGLE_AI_API_KEY;
    if (!apiKey) {
        console.warn(
            '   GEMINI_API_KEY not set — using mechanical PR copy.',
        );
        return;
    }

    // Truncate body aggressively. PR descriptions can be huge (templates,
    // screenshots, repro logs); we only need the first paragraph for
    // intent. Keeps the prompt small enough to fit comfortably in one
    // generateContent call regardless of release size.
    const trimmed = prs.map((pr) => ({
        number: pr.number,
        type: pr.type,
        scope: pr.scope ?? null,
        title: pr.title,
        branch: pr.headRefName ?? null,
        body: (pr.body ?? '')
            .replace(/\r/g, '')
            .split('\n')
            .filter((l) => !l.trim().startsWith('<!--'))
            .join('\n')
            .trim()
            .slice(0, 800),
    }));

    const prompt = [
        'You write the Kodus public changelog. Follow this voice guide strictly:',
        '',
        voice,
        '',
        'For each PR below, produce ONE single-sentence bullet (max ~140',
        "characters) that tells a real engineer what changed and why they",
        'should care. Plain text — no markdown, no leading dash, no PR',
        "number (it is appended automatically). Don't reference branch",
        'names, internal class names, or implementation detail. If a PR is',
        'pure internal cleanup with no user-visible effect, return an',
        'empty string for that summary and we will drop it from the',
        "changelog. Capitalise the first letter; don't end with a period",
        'unless the sentence demands it.',
        '',
        'Output JSON only with shape:',
        '{"items": [{"number": <int>, "summary": "<one-sentence string>"}]}',
        '',
        'PRs to summarise:',
        JSON.stringify(trimmed, null, 2),
    ].join('\n');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

    let response: Response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-goog-api-key': apiKey,
            },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: {
                    thinkingConfig: { thinkingBudget: 0 },
                    maxOutputTokens: 4096,
                    temperature: 0.3,
                    responseMimeType: 'application/json',
                    responseSchema: {
                        type: 'object',
                        properties: {
                            items: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        number: { type: 'integer' },
                                        summary: { type: 'string' },
                                    },
                                    required: ['number', 'summary'],
                                },
                            },
                        },
                        required: ['items'],
                    },
                },
            }),
        });
    } catch (err) {
        console.warn(
            `   Gemini request failed (${(err as Error).message}). Using mechanical PR copy.`,
        );
        return;
    }

    if (!response.ok) {
        const text = await response.text();
        console.warn(
            `   Gemini returned ${response.status} ${response.statusText}: ${text}\n   Using mechanical PR copy.`,
        );
        return;
    }

    const json = (await response.json()) as {
        candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
        }>;
    };
    const text = (json.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('')
        .trim();
    if (!text) {
        console.warn('   Gemini returned empty PR-polish response. Using mechanical copy.');
        return;
    }

    let parsed: { items: Array<{ number: number; summary: string }> };
    try {
        parsed = JSON.parse(text);
    } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) {
            console.warn('   Gemini PR-polish output not JSON. Using mechanical copy.');
            return;
        }
        try {
            parsed = JSON.parse(match[0]);
        } catch {
            console.warn('   Gemini PR-polish output not parseable. Using mechanical copy.');
            return;
        }
    }

    const byNumber = new Map<number, string>();
    for (const it of parsed.items ?? []) {
        if (typeof it.number === 'number' && typeof it.summary === 'string') {
            byNumber.set(it.number, it.summary.trim());
        }
    }
    for (const pr of prs) {
        const summary = byNumber.get(pr.number);
        // Distinguish "Gemini intentionally dropped this PR" (empty
        // string returned) from "Gemini didn't mention this PR at all"
        // (number missing from response). The first means user wanted it
        // dropped; the second means we asked for N items and got fewer
        // back, which is a quality bug we should surface.
        if (summary !== undefined) {
            pr.polished = summary;
        }
    }

    const missing = prs.filter((pr) => pr.polished === undefined);
    if (missing.length > 0) {
        console.warn(
            `   Gemini returned ${parsed.items?.length ?? 0}/${prs.length} items. Missing: ${missing.map((p) => '#' + p.number).join(', ')}. Those will use mechanical formatting.`,
        );
    }
    const dropped = prs.filter((pr) => pr.polished === '');
    if (dropped.length > 0) {
        console.log(
            `   Gemini flagged as internal-only: ${dropped.map((p) => '#' + p.number).join(', ')}.`,
        );
    }
}

/**
 * Strips the train prefix (`selfhosted-`, `web-`, `v`) so the public copy
 * uses a single neutral version label. The same release lands in cloud
 * and self-hosted within days of each other — both audiences read the
 * same Mintlify and the same Discord channel, so the headline shouldn't
 * lean into either side.
 */
function neutralVersion(tag: string): string {
    return tag.replace(/^(selfhosted-|web-|v)/, '');
}

/**
 * Returns an audience suffix for the entry headline. Empty string means
 * "available everywhere" — no badge needed. Otherwise one of:
 *   ` · Cloud only`
 *   ` · Self-hosted only`
 */
function audienceBadge(audience: Audience[] | undefined): string {
    if (!audience || audience.length === 0 || audience.length === 2) return '';
    if (audience[0] === 'cloud') return ' · Cloud only';
    if (audience[0] === 'self-hosted') return ' · Self-hosted only';
    return '';
}

function combinedBadge(promotion: Promotion): string {
    const parts: string[] = [];
    if (promotion.toStage === 'beta') parts.push('Beta');
    const aud = audienceBadge(promotion.audience).replace(/^ · /, '');
    if (aud) parts.push(aud);
    return parts.length > 0 ? ` [${parts.join(' · ')}]` : '';
}

function writeReleaseMdx(
    tag: string,
    items: ReleaseEntryItem[],
    commits: PRItem[],
): string {
    mkdirSync(CHANGELOG_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const filename = `${date}-${slugify(tag)}.mdx`;
    const filePath = resolve(CHANGELOG_DIR, filename);

    const version = neutralVersion(tag);
    const releaseLabel = `Release ${version}`;

    const lines = [
        '---',
        `title: "${escapeQuote(releaseLabel)}"`,
        `date: "${date}"`,
        `release: "${tag}"`,
        `version: "${version}"`,
        '---',
        '',
        `## ${releaseLabel}`,
        '',
    ];

    if (items.length > 0) {
        lines.push("### What's new", '');
        for (const { promotion, copy } of items) {
            lines.push(
                `**${copy.headline}${combinedBadge(promotion)}**`,
                '',
                copy.body,
                '',
            );
            if (promotion.documentation_url) {
                lines.push(
                    `[Read more →](/${promotion.documentation_url})`,
                    '',
                );
            }
        }
    }

    const fixes = commits.filter((c) => c.type === 'fix');
    const improvements = commits.filter((c) => c.type === 'feat');
    const perf = commits.filter((c) => c.type === 'perf');

    if (improvements.length > 0) {
        lines.push('### Improvements', '');
        for (const c of improvements) {
            lines.push(`- ${formatPRSubject(c)}`);
        }
        lines.push('');
    }
    if (perf.length > 0) {
        lines.push('### Performance', '');
        for (const c of perf) {
            lines.push(`- ${formatPRSubject(c)}`);
        }
        lines.push('');
    }
    if (fixes.length > 0) {
        lines.push('### Bug fixes', '');
        for (const c of fixes) {
            lines.push(`- ${formatPRSubject(c)}`);
        }
        lines.push('');
    }

    writeFileSync(filePath, lines.join('\n'));
    return filePath;
}

function buildDiscordContent(
    tag: string,
    items: ReleaseEntryItem[],
    commits: PRItem[],
): string {
    const releaseLabel = `Release ${neutralVersion(tag)}`;
    const lines = [`**${releaseLabel}**`, ''];

    if (items.length > 0) {
        lines.push("__What's new__");
        for (const { promotion, copy } of items) {
            lines.push(`**${copy.headline}${combinedBadge(promotion)}**`);
            lines.push(copy.body);
            lines.push('');
        }
    }

    const fixes = commits.filter((c) => c.type === 'fix');
    const improvements = commits.filter((c) => c.type === 'feat');
    const perf = commits.filter((c) => c.type === 'perf');

    if (improvements.length > 0) {
        lines.push('__Improvements__');
        for (const c of improvements) {
            lines.push(`• ${formatPRSubject(c)}`);
        }
        lines.push('');
    }
    if (perf.length > 0) {
        lines.push('__Performance__');
        for (const c of perf) {
            lines.push(`• ${formatPRSubject(c)}`);
        }
        lines.push('');
    }
    if (fixes.length > 0) {
        lines.push('__Bug fixes__');
        for (const c of fixes) {
            lines.push(`• ${formatPRSubject(c)}`);
        }
        lines.push('');
    }

    return lines.join('\n').trim();
}

function escapeQuote(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function postDiscord(
    tag: string,
    content: string,
): Promise<void> {
    // Pick the first webhook that's set, in order of canonical → legacy.
    // Lets ops migrate to #releases by just creating the new secret —
    // until then this transparently keeps using the historical SH
    // channel or the legacy general one. Same fallback shape every
    // workflow uses.
    //
    // Strips whitespace defensively: pasting a long webhook URL into a
    // shell argument can wrap and embed a literal newline, which breaks
    // Discord auth without an obvious error.
    const candidates: Array<[string, string]> = [
        ['DISCORD_WEBHOOK_COMMUNITY', process.env.DISCORD_WEBHOOK_COMMUNITY ?? ''],
        ['DISCORD_WEBHOOK_SELFHOSTED', process.env.DISCORD_WEBHOOK_SELFHOSTED ?? ''],
        ['DISCORD_WEBHOOK', process.env.DISCORD_WEBHOOK ?? ''],
    ];
    const picked = candidates.find(([, v]) => v.replace(/\s/g, '') !== '');
    const rawWebhook = picked ? picked[1] : '';
    const sourceName = picked ? picked[0] : 'DISCORD_WEBHOOK_COMMUNITY';
    const webhook = rawWebhook.replace(/\s/g, '');

    if (!webhook) {
        console.warn(
            `No Discord webhook configured (tried DISCORD_WEBHOOK_COMMUNITY, DISCORD_WEBHOOK_SELFHOSTED, DISCORD_WEBHOOK), skipping post for ${tag}.`,
        );
        return;
    }
    console.log(`Discord channel source: ${sourceName}`);

    // Diagnostic info without leaking the URL — helps debug 401s caused
    // by accidental whitespace, mis-pasted secrets, or revoked webhooks.
    const trimmedChars = rawWebhook.length - webhook.length;
    const tail = webhook.slice(-12);
    console.log(
        `Posting to Discord (url length=${webhook.length}, trimmed ${trimmedChars} char(s), ends in "${tail}")`,
    );

    const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
    });
    if (!res.ok) {
        const text = await res.text();
        console.warn(
            `Discord post failed (${res.status} ${res.statusText}): ${text}`,
        );
    }
}

async function main(): Promise<void> {
    const { tag, dryRun } = parseArgs();
    const previousTag = findPreviousTag(tag);

    console.log(
        `Building release entry for ${tag} (previous: ${previousTag ?? 'none'})`,
    );

    const beforeYaml = loadYamlAtRef(previousTag);
    const afterYaml = loadYamlAtRef(tag);

    // Tag-driven publishes are about what the release shipped to users.
    // Internal alpha promotions (private beta) don't belong here — those
    // are coordinated directly with design partners.
    const promotions = afterYaml
        ? diffPromotions(beforeYaml, afterYaml).filter(
              (p) =>
                  p.toStage === 'beta' ||
                  p.toStage === 'general-availability',
          )
        : [];

    const allPRs = loadPRsBetweenTags(previousTag, tag);

    console.log(
        `→ ${promotions.length} feature promotion(s), ${allPRs.length} user-facing PR(s) in range`,
    );

    if (promotions.length === 0 && allPRs.length === 0) {
        console.log(
            'Nothing user-facing in this release range. Skipping publish.',
        );
        return;
    }

    const voice = readFileSync(resolve(REPO_ROOT, VOICE_PATH), 'utf8');
    const items: ReleaseEntryItem[] = [];

    for (const promotion of promotions) {
        console.log(
            `   feature: ${promotion.flagKey} ${promotion.fromStage ?? 'new'} -> ${promotion.toStage}`,
        );
        const copy = await generateCopy(promotion, voice);
        items.push({ promotion, copy });

        if (dryRun) {
            console.log(`     headline: ${copy.headline}`);
            console.log(`     body: ${copy.body}`);
        }
    }

    // Rewrite the raw PR titles into user-facing copy before they hit
    // Mintlify or Discord. Gemini may also signal "this PR has no user
    // impact" with an empty summary — drop those entirely so internal
    // cleanup doesn't pollute the public changelog.
    await polishPRsWithGemini(allPRs, voice);
    const commits = allPRs.filter((pr) => {
        if (pr.polished === undefined) return true;
        return pr.polished.length > 0;
    });
    const droppedAsInternal = allPRs.length - commits.length;
    if (droppedAsInternal > 0) {
        console.log(
            `   Dropped ${droppedAsInternal} PR(s) flagged as internal-only by Gemini.`,
        );
    }

    if (dryRun) {
        for (const c of commits) {
            console.log(`   PR (${c.type}): ${formatPRSubject(c)}`);
        }
        return;
    }

    const mdxPath = writeReleaseMdx(tag, items, commits);
    console.log(`Wrote ${mdxPath}`);

    const discordContent = buildDiscordContent(tag, items, commits);
    await postDiscord(tag, discordContent);
}

void main().catch((err: Error) => {
    console.error(err.stack ?? err.message);
    process.exit(1);
});
