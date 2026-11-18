import type { PublicationKindView, RunPublication } from "../contracts";
import type { Tone } from "../labels";

// What reached the pull request, from the product's own publication record
// (run-publication-view.ts on the API). Never from the Runtime's "published"
// stream event: that one only says the Runtime asked.

export type PublicationKind = "check" | "comment";

export type PublicationLine = {
    label: string;
    tone: Tone;
    /** One sentence for the reader: what the PR shows, and what Kodus does next. */
    detail?: string;
};

const PHASE_SHOWN: Record<NonNullable<PublicationKindView["showing"]>, string> =
    {
        booting: "starting the machines",
        applying: "building this pull request",
        testing: "testing",
        reporting: "writing the report",
    };

const SKIP_DETAIL: Record<
    NonNullable<PublicationKindView["reason"]>,
    string
> = {
    checks_unavailable:
        "This Git platform or integration has no checks; the comment carries the result.",
    status_permission_missing:
        'The GitHub token connected to Kodus cannot write commit statuses. Give it the "Commit statuses: Read and write" permission (fine-grained token) or the repo:status scope (classic token); the comment carries the result meanwhile.',
    stale_comment: "A newer Run of this pull request owns the comment.",
    stale_check: "A newer Run on this commit owns the check.",
};

const retryDetail = (view: PublicationKindView) =>
    view.redriveAttempts
        ? `The last delivery failed; Kodus is retrying (retry ${view.redriveAttempts}).`
        : "The last delivery failed; Kodus is retrying.";

/** The words and tone of one kind's publication. */
export const publicationLine = (
    kind: PublicationKind,
    view: PublicationKindView,
): PublicationLine => {
    switch (view.status) {
        case "published":
            return view.fallback
                ? {
                      label: "Short notice only",
                      tone: "warning",
                      detail: "The full report could not be posted; the PR comment points here.",
                  }
                : { label: "On the pull request", tone: "success" };
        case "skipped":
            return {
                label: "Not posted",
                tone: "neutral",
                detail: view.reason ? SKIP_DETAIL[view.reason] : undefined,
            };
        case "failed":
            return {
                label: "Could not post",
                tone: "danger",
                detail: "Kodus gave up after several tries; the result is only on this page.",
            };
        case "not_expected":
            return { label: `No ${kind} for this Run`, tone: "neutral" };
        case "pending":
            return {
                label: view.retrying ? "Retrying" : "Not on the PR yet",
                tone: view.retrying ? "warning" : "info",
                detail: view.retrying
                    ? retryDetail(view)
                    : view.showing
                      ? `The PR comment still shows progress (${PHASE_SHOWN[view.showing]}).`
                      : undefined,
            };
    }
};

/** A simulation posts nothing, by design: said instead of the two lines. */
export const postsNothing = (publication: RunPublication) =>
    !publication.postsToPullRequest;
