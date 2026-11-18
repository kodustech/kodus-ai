import type { FixAction } from "@libs/runtime/blockers/catalog";
import { addSearchParamsToUrl } from "src/core/utils/url";

import type { BlockerFix, BlockerGroup, RuntimeBlocker } from "../contracts";

const isRawBlocker = (b: BlockerGroup | RuntimeBlocker): b is RuntimeBlocker =>
    typeof (b as RuntimeBlocker).seen === "object" &&
    (b as RuntimeBlocker).seen !== null;

const later = (a?: string, b?: string) =>
    !a ? b : !b ? a : Date.parse(b) > Date.parse(a) ? b : a;

/**
 * Blockers grouped by signature, most frequent first. Accepts the grouped rows
 * of GET /environments/:id/blockers or raw Blockers, so the Health screen
 * reads the same either way.
 */
export const groupBlockersBySignature = (
    rows: Array<BlockerGroup | RuntimeBlocker>,
): BlockerGroup[] => {
    const groups = new Map<string, BlockerGroup>();
    for (const row of rows) {
        const incoming: BlockerGroup = isRawBlocker(row)
            ? {
                  signature: row.signature,
                  kind: row.kind,
                  title: row.title,
                  count: row.seen.count,
                  lastAt: row.seen.lastAt,
                  lastPr: row.seen.lastPr,
                  state: row.state,
                  fixes: row.fixes,
              }
            : row;
        const prev = groups.get(incoming.signature);
        if (!prev) {
            groups.set(incoming.signature, { ...incoming });
            continue;
        }
        const newest = later(prev.lastAt, incoming.lastAt);
        const incomingIsNewest =
            newest === incoming.lastAt && newest !== prev.lastAt;
        groups.set(incoming.signature, {
            ...prev,
            count: prev.count + incoming.count,
            lastAt: newest,
            lastPr: incomingIsNewest
                ? (incoming.lastPr ?? prev.lastPr)
                : (prev.lastPr ?? incoming.lastPr),
            title: prev.title ?? incoming.title,
            state: incomingIsNewest
                ? (incoming.state ?? prev.state)
                : (prev.state ?? incoming.state),
            fixes: prev.fixes?.length ? prev.fixes : incoming.fixes,
        });
    }
    return [...groups.values()].sort(
        (a, b) =>
            b.count - a.count ||
            (Date.parse(b.lastAt ?? "") || 0) -
                (Date.parse(a.lastAt ?? "") || 0),
    );
};

/** Environment Health (screen 4): the blockers seen 10 times or more first, the rest apart. */
export const FREQUENT_BLOCKER = 10;
export const splitBlockersByFrequency = (groups: BlockerGroup[]) => ({
    frequent: groups.filter((g) => g.count >= FREQUENT_BLOCKER),
    occasional: groups.filter((g) => g.count < FREQUENT_BLOCKER),
});

/** The DOM id of a blocker row, so "Details" can link to it. */
export const blockerAnchorId = (signature: string) =>
    `blocker-${signature.replace(/[^A-Za-z0-9_-]/g, "-")}`;

/** The Machine size section of the environment page. */
export const MACHINE_SIZE_SECTION_ID = "machine-size";
/** The Secrets section of the Runtime settings page. */
export const SECRETS_SECTION_ID = "secrets";
/** The Cells section of the environments page. */
export const CELLS_SECTION_ID = "cells";

export type SettingsFixLink = { label: string; href: string };

// The catalog marks these `dev`, but the dev makes them in Kodus, not in the
// repository: the card says so and links to the setting.
const SETTINGS_FIXES = {
    // A host that answered without a credential (S-58): an org secret with that host, name prefilled.
    add_secret: (_environmentId: string, fix?: Pick<BlockerFix, "host" | "secretName">) => ({
        label: fix?.secretName ? `Create the secret ${fix.secretName}` : "Create a secret",
        href: addSearchParamsToUrl("/runtime/settings", {
            ...(fix?.secretName ? { secretName: fix.secretName } : {}),
            ...(fix?.host ? { secretHost: fix.host } : {}),
        }) + `#${SECRETS_SECTION_ID}`,
    }),
    bump_machine: (environmentId: string) => ({
        label: "Change the machine size",
        href: `/runtime/environments/${encodeURIComponent(environmentId)}#${MACHINE_SIZE_SECTION_ID}`,
    }),
    use_own_cell: () => ({
        label: "Connect a host",
        href: `/runtime/environments#${CELLS_SECTION_ID}`,
    }),
} satisfies Partial<
    Record<FixAction, (environmentId: string, fix?: Pick<BlockerFix, "host" | "secretName">) => SettingsFixLink>
>;

const isSettingsFix = (action: string): action is keyof typeof SETTINGS_FIXES =>
    Object.hasOwn(SETTINGS_FIXES, action);

/** Where a fix made in Kodus's settings is made; undefined for any other fix. */
export const settingsFixLink = (
    fix: Pick<BlockerFix, "action" | "host" | "secretName">,
    environmentId: string,
): SettingsFixLink | undefined =>
    isSettingsFix(fix.action)
        ? SETTINGS_FIXES[fix.action](environmentId, fix)
        : undefined;

/** Where a repository is connected to Kodus: the Git integration's repositories. */
export const CONNECT_REPOSITORIES_HREF = "/settings/git/repositories";

/** A fix about the environment's repositories, as the card acts on it. */
export type MembershipFixAction =
    /** One click: add the connected repository to this environment. */
    | { kind: "add"; repositoryId: string; repository: string; alias?: string }
    /** Connect the repository to Kodus first, in the Git settings. */
    | { kind: "connect"; repository: string; href: string };

/**
 * The membership fix of a `needs_member:` or `needs_connection:` card
 * (MembershipBlockerFix), or undefined for any other fix. An add without the
 * repository to add is not offered.
 */
export const membershipFixOf = (
    fix: Pick<BlockerFix, "action" | "repositoryId" | "repository" | "alias">,
): MembershipFixAction | undefined => {
    const repository = fix.repository?.trim();
    if (fix.action === "add_repository" && fix.repositoryId && repository)
        return {
            kind: "add",
            repositoryId: fix.repositoryId,
            repository,
            ...(fix.alias ? { alias: fix.alias } : {}),
        };
    if (fix.action === "connect_repository" && repository)
        return { kind: "connect", repository, href: CONNECT_REPOSITORIES_HREF };
    return undefined;
};
