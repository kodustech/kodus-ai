import type { DiffRef } from "../contracts";

// "Changed in pkg/api/health.go:23": where the diff changes the code a
// finding reaches (ProbeVerdict.diffRef). Linked to the file at the PR's head
// commit on GitHub when the page knows the PR's GitHub URL; plain text
// otherwise (another platform, or a PR Kodus never reviewed).

export type CodeRef = {
    /** "pkg/api/health.go:23". */
    label: string;
    href?: string;
};

const GITHUB_PR =
    /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/pull\/\d+(?:[/?#].*)?$/;
const SHA = /^[0-9a-f]{7,40}$/i;

/** A repository-relative path the link may carry: no scheme, no `..`, no leading slash. */
const safePath = (file: string) =>
    file !== "" &&
    !file.startsWith("/") &&
    !file.includes("\\") &&
    !/^[a-z][a-z0-9+.-]*:/i.test(file) &&
    file.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");

export const codeRefOf = (
    ref: DiffRef | undefined,
    pr?: { url?: string; headSha?: string },
): CodeRef | undefined => {
    const file = ref?.file?.trim();
    if (!file) return undefined;
    const line =
        typeof ref?.line === "number" &&
        Number.isInteger(ref.line) &&
        ref.line > 0
            ? ref.line
            : undefined;
    const label = line ? `${file}:${line}` : file;
    const repo = pr?.url ? GITHUB_PR.exec(pr.url) : null;
    if (!repo || !pr?.headSha || !SHA.test(pr.headSha) || !safePath(file))
        return { label };
    const path = file.split("/").map(encodeURIComponent).join("/");
    return {
        label,
        href: `https://github.com/${repo[1]}/${repo[2]}/blob/${pr.headSha}/${path}${line ? `#L${line}` : ""}`,
    };
};
