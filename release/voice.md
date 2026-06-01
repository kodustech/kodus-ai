# Kodus changelog voice

This file is the style guide consumed by the LLM that drafts every public
changelog entry. Update it when our product voice evolves; commit changes
through PR review like any other source-of-truth file.

## Tone

- Direct. Speak to a real engineer who is short on time.
- No buzzwords ("revolutionary", "next-generation", "powerful") and no hype.
- Active voice. Subject does the action.
- One feature per entry. Don't bundle.
- 2 to 4 sentences max for the body. Headlines under 8 words.

## Structure

Each public entry is:

1. **Headline** — what the feature is, in plain language.
   Examples:
   - "Agent-first code review is now generally available"
   - "GitHub Enterprise Server PAT auth in beta"
2. **Body** — what changes for the user, why it matters, and a single
   pointer to deeper docs if a `documentation_url` is present in the
   catalog. Speak to the user's problem, not our implementation.
3. **CTA / availability line** when applicable: "Available to organizations
   on the beta release track. Switch tracks under Settings → General."

## What to avoid

- Internal terms (engine names, pipeline stages, code review v3, agent loop, etc.)
  unless they are already public-facing branding (e.g. "agent-first review").
- Mentioning customers by name unless explicitly listed in the catalog
  metadata as `payload.featured_orgs`.
- Saying "we're excited" / "we're thrilled". Show, don't tell.
- Rolling-release jargon (% rollout, allowlist, flag conditions). Those
  decisions live in the operational layer, not the user-facing changelog.

## Audience badges

Entries automatically get an audience suffix appended to the headline by
the publish script:

- Both audiences (default) → no badge
- Cloud only → ` · Cloud only`
- Self-hosted only → ` · Self-hosted only`

The LLM should NOT add these to the headline manually — the script
handles it. The body MAY mention practical implications: for example, a
self-hosted-only feature should mention `BETA_FEATURES=true` or the
upgrade path. A cloud-only feature should not promise anything to
self-hosted users.

## Stage-specific framing

The same public changelog hosts both beta and GA entries — the badge in the
headline is what distinguishes them. Don't write paragraph-level copy that
re-explains the difference; the badge does that.

- **`beta` promotion**: headline should include `[Beta]` so readers know
  the feature isn't stable yet. Body says what it does and how to enable
  it ("Available to organizations on the beta release track."). Don't
  promise stability.
- **`general-availability` promotion**: headline drops the badge. Body
  past-tenses the work and present-tenses the capability. Mention if
  there's a meaningful behavior change for stable-track customers
  who are receiving it for the first time.
- **`alpha` promotion** (private beta): no public entry — only the
  internal Discord channel sees it. Body can be more candid about what
  is being tested with which design partners.
- **Sunset / rollback** (a feature is archived from the catalog after a
  beta release): be honest. "We're rolling back X. The early access
  program turned up reliability issues we want to fix before re-launching."
  No spin.

## When in doubt

Write like Stripe or Linear changelogs, not press releases.
