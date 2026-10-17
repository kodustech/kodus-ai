# reply-addressing — unmentioned replies in Kody threads

> - **Answers:** When someone replies in a thread Kody started without writing @kody, does the classifier answer the replies meant for Kody and stay out of the rest (#1946)?
> - **Runs:** nightly on one real model when a file it loads changed (`evals/nightly-evals.js`, `cases.json`); every PR (`evals/wiring-smoke.js`) against the scripted model; weekly on every tier-0 model (`cases.json`) and DeepSeek on `repo-cases.json` too, each against its floor (`evals/weekly.js`).
> - **Run it:** `pnpm eval:reply-addressing` · `node evals/reply-addressing/run.js --dataset=repo-cases --model=gemini-3-flash-preview`
> - **Gate:** `--gate` fails below the model's floor in `evals/reply-addressing/targets.json` (share of replies handled right); exit 2 when more than 5% of calls fail.
> - **Cost:** 70 short calls per repeat (`cases`), 373 (`repo-cases`).

`run.js` runs what the conversation use case runs on an unmentioned reply
(`libs/platform/application/use-cases/codeManagement/reply-thread.ts`): the
reply's thread rebuilt from the PR's comments as GitHub returns them (Kody's
from its app login, with the marker its comments carry), the free gate
(`implicitReplyGate`), then the classifier on the model the org routes the
conversation task to, through production's `PermissionValidationService` over
the org's stored model config (`evals/shared/model-route.js`: a BYOK config
holding the model).

`cases.json` holds the 64 boundary conversations from the TypeSafe experiment
on the issue, plus threads where two people talk and one of them turns to Kody
(`category: multi-human-to-kody`). The code gate runs before the classifier
as in production (Kody started the thread, the author is not Kody, the bot
and thread caps); it silences none of these cases, and a reply it silenced
would count as not answered.

`repo-cases.json` holds real replies from review threads Kody started on
kodustech/kodus-ai (from April 2025), each with its PR link. Most were written
by people or by Claude working on their behalf, answering the finding with a
disposition ("Fixed in …", "Not applying: …"), which the issue counts as
directed at Kody. Each thread was read and labeled by hand: a reply that
@-mentions or answers another person is `quiet`. Dropped: replies that were
Kody's own answers posted from a team member's account before the bot had its
own identity, replies that talk about Kody in the third person (ambiguous), and
near-duplicate texts.

The result prints precision, recall and specificity overall and on
multi-human threads alone. A false answer interrupts people talking to each
other; a miss only means the person writes @kody, so precision is the number
to watch.
