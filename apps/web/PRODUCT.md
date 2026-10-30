# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: the engineering leader / manager.** They come to configure and to measure — Kody Rules, code-review settings, BYOK and per-model cost, Cockpit. Their job is deciding *how the team gets reviewed* and judging whether it is paying off. Sessions are deliberate and less frequent than a developer's.

**Secondary, confirmed in code: the developer receiving reviews.** They live in the pull request, not in this app; when they do come in, it is for their own queue and what needs attention. The Pull Requests surface already splits by role (an individual queue view and a team view, with owner treated as leader), so role-aware surfaces are an established pattern, not a hypothesis.

The primary designation is a priority ordering, not an exclusion: where the two audiences conflict on a shared surface, the leader's job wins.

## Product Purpose

Kodus reviews pull requests with an AI agent ("Kody") and reports on that review practice. The web app is where a team configures what gets reviewed and how, connects the tools the review draws context from, and sees whether the practice is working — volume, cost, and what needs attention.

Success for the primary user is a review practice they trust enough to stop supervising, at a cost they can see and control.

## Positioning

**BYOK without a toll.** The customer brings their own model key on a normal plan — no self-hosting requirement, no enterprise contract, no seat floor — with cost visible per model.

This is the mechanism a neighboring product cannot truthfully copy today, because for the rest of the category BYOK is a compliance concession granted to large accounts: it is gated behind self-hosting, an Enterprise Server edition, an open-source edition, or a seat minimum. The durable claim is therefore not "we have BYOK" but *where* it is available.

## Operating Context

- A pull request opens on one of five git platforms; the review runs and posts its findings back to that platform. The app is the control surface, never the delivery surface — the review itself is consumed in the PR.
- The leader's recurring loop: configure rules and review settings, connect context sources, then read back volume, cost, and exceptions.
- Kody Rules are authored and governed here: versioned in the repository, with inheritance, a shared library, IDE sync, an approval flow, and suggested rules the user approves or rejects.
- Plugins (MCP) connect external context — issue trackers, docs, search, meeting transcripts — and some read through the git integration the team already connected rather than asking for a second credential.
- Two deployment shapes with the same product: managed cloud, and self-hosted installed by the customer.
- A first-run setup wizard onboards a new organization before the main app is usable.

## Capabilities and Constraints

Confirmed surfaces in `src/app/(app)`: cockpit, pull-requests, issues, review-suggestions, library, byok, token-usage, cli-reviews, settings, organization, choose-plan, user-logs, helpdesk — plus a `(setup)` wizard, `(auth)`, and states for forbidden and pending approval.

**Durable constraints, confirmed with the team. These bind every future surface:**

1. **Open core.** The repository is public and enterprise code is confined to `features/ee` (and `libs/ee` on the backend). A new surface has to respect that boundary rather than discover it later.
2. **Self-hosted ↔ cloud parity.** Anything the cloud can do, a self-hosted install must be able to do. In particular, a capability reachable only through an environment variable is broken for every cloud customer, because they cannot set one — parity is a product rule, not an ops preference.
3. **Role decides what is shown.** Every new surface joins the permission map and the route manifest. Role governs presentation, not only authorization.
4. **Five git platforms, none assumed.** GitHub, GitLab, Bitbucket Cloud, Bitbucket Data Center, Azure, and Forgejo are supported; Bitbucket Data Center and Azure are first-class, not degraded fallbacks. No feature may assume GitHub semantics.

**Plan tiers** exist and gate features (a free BYOK tier, team, and enterprise), with a `choose-plan` surface and plan-aware gating already applied to Cockpit, Plugins, and Kody Rules.

**Terminology:** *Kody* is the agent; *Kody Rules* are the team's authored review rules; *BYOK* is a customer-supplied model key; *Plugins* are MCP connections; a *credential* holds a key and a *slot* is a configured model.

**Viewport targets.** The pull request detail surface is **desktop-only by decision**, not by omission. Its three-column shell (file tree · diff · suggestions) collapses to the diff alone below the `lg` breakpoint, and the file tree and suggestion rail are hidden there with no alternative entry point. This is deliberate: the surface exists to read a diff side by side with its review, and the primary user is at a desk. Do not treat the hidden panels as a responsive defect, and do not add a mobile drawer for them without revisiting this decision.

**Explicitly undecided:** no accessibility standard has been established for this app (see below); no i18n exists in the product UI, though the documentation is published in five languages.

## Brand Commitments

- Product name **Kodus**; the review agent is **Kody**.
- Product UI copy is written in **English**. The repository is public, so code comments, commit messages, and pull request descriptions are English as well; Portuguese is used for internal conversation and for `docs/pt-br`.
- Documentation is maintained in five languages: `en`, `es`, `ja`, `pt-br`, `zh`. A user-facing change that ships documentation ships it in all five.
- An incumbent visual system exists and is authoritative: roughly 67 design tokens in `src/app/globals.css` covering background, border, text, accent, secondary, and tertiary ramps. It is recorded here as a fact only — this file makes no visual decisions, and the system is neither documented nor replaced by `init`.

## Evidence on Hand

- Documentation source in `docs/how_to_use/{en,es,ja,pt-br,zh}`, including the BYOK guide.
- The managed plugin catalog with real integrations (Atlassian Rovo, Linear, Notion, Git Issues, Sentry, Exa, Fireflies, Kodus Docs, Kodus OSV).
- An evaluation harness for review quality lives in the repository, so claims about review performance can be grounded rather than asserted.

**Absences future work must not fabricate:** no testimonials, named customers, case studies, press quotes, benchmark numbers, uptime figures, or pricing claims have been confirmed in this record. If a surface needs social proof or a number, it must be supplied, not invented.

## Product Principles

1. **Answer the leader's question before showing the detail.** Every surface they own should resolve "is this working, and what do I change?" on arrival; tables and drill-downs come after.
2. **Nothing important may require an operator.** If a capability can only be reached by editing an environment variable or a config file on a server, it does not exist for most customers. This is the same rule that makes the positioning true.
3. **Never assume GitHub.** Naming, iconography, affordances, and copy have to survive Bitbucket Data Center and Azure without reading as an afterthought.
4. **Role shapes the surface, not just the gate.** Hiding what a role cannot use is preferable to showing it disabled, and the two audiences may need genuinely different views of the same data.
5. **Cost is a first-class product fact.** Because the customer brings the key, spend is something they own and must be able to see — cost belongs in the interface, not only in a report.

## Accessibility & Inclusion

No product-specific accessibility requirement or target standard has been established. Recorded as an open decision so a future round asks rather than assumes; until it is set, work follows ordinary good practice without claiming conformance to a named standard.
