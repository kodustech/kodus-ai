# Intent oracle

The gate compares the PR with its base. That finds regressions, but it cannot tell whether a change does what the PR says it does: a route the PR adds has no base to compare with, and a behaviour the PR changes on purpose differs from the base whether it is right or wrong.

Measured on kr-shop, 2026-11-18, four features, each as a PR with a planted bug and as a correct PR with the same description:

| Feature | Bug PR | Correct PR |
|---|---|---|
| Quote with a coupon (#7/#8) | no regressions | no regressions |
| Filter by item (#9/#10) | regression, on the wrong request (the planner copied the bug's parameter name from the diff) | regression |
| Order total (#11/#12) | regression | regression |
| At most 10 units (#13/#14) | regression | regression |

In every pair the bug and the correct PR got the same verdict: the bug is caught for the right reason in 1 of 4, and 3 of 4 correct PRs fail the check.

The intent oracle checks what the PR says it does.

## Decisions

1. **Scope**: new routes and behaviour a PR changes on existing routes.
2. **Sources**: the PR description and the linked tasks (GitHub issue, Jira, Linear, Notion, Azure), as untrusted data. Never a code comment, never a README.
3. **The expected value never comes from the PR's code.** The intent author does not read the diff's content or the head's files. It reads the PR text, the linked tasks, the entry points (method and path) and what the base answers. A planner that reads the code copies the bug (kr-shop #9).
4. **No LLM in the verdict.** The intent author writes executable assertions before the Run tests; a deterministic check decides.
5. **Every assertion quotes its source.** It carries the exact sentence of the PR or task it comes from. An assertion whose quote is not a substring of the source text is dropped before the Run tests.
6. **No stated intent, no assertion.** A PR that describes no testable behaviour gets none, and the comment says so.
7. **A failed assertion is an intent mismatch**: a finding of its own kind that does not fail the check until its false-positive rate is measured.
8. **A passed assertion may explain a difference.** A base-against-PR difference is a described change, not a regression, only when all hold:
   - an assertion from a quoted sentence covers the probe;
   - that assertion passed on the PR side, on every round;
   - every differing field is one the assertion reads;
   - the PR did not answer 5xx.

   Anything else stays a regression. A described change is shown on the comment and never fails the check.
9. **On by default** for an org the Runtime is released to, with an org setting to turn it off.

## Assertions

Closed set, evaluated on the PR side's JSON response (`fields.json`), never code:

- `status`: the HTTP status equals a number.
- `equals`: a JSON path equals a literal (`$.total == 320`).
- `sameAs`: a JSON path equals another (`$.charge == $.total`).
- `computed`: a JSON path equals arithmetic over other paths and the request's own fields: `+ - * /`, numbers, parentheses, and a tolerance for money (`$.total == $.unitPrice * $.quantity`, ±0.01).

Paths are `$`, then `.key` or `[index]`; `$request.key` reads the request's JSON body inside `computed`; an `equals` literal is any JSON value (`$ == [{"id":1,…}]` for a whole list). An intent probe's own expectation is its assertions, so an answer the PR did not change is `not_reproduced` when they hold and `pre_existing` when they fail.

## Choices the build made

- **Which difference an assertion reads**: the fields under its paths; a `status` assertion that held where the status changed also reads the body (another outcome's body says nothing next to main's, kr-shop #14); a path through an array index reads one element, never the whole array.
- **Planned probes**: explained only through an intent probe with the same method, path and query, target and JSON body (headers aside). That intent probe is not replayed: its assertions are read on the planned probe's own PR rounds. A failed one is recorded beside the planned verdict, which keeps its regression.
- **What a mismatch replaces**: `not_reproduced`, `pre_existing`, `new_endpoint`, `inconclusive` and a non-5xx `behavior_change`. Never a 5xx, a lost machine or an error on a new endpoint.
- **Coverage**: a described change settles its entry point; an intent mismatch settles nothing; an intent probe the gate could not decide never holds an entry point back. The check title adds `· N described change(s)` and `· N not what the PR describes`.
- **The setting**: the Run request's `intentChecks` (absent: on). The product's settings field, its storage and the request builder are not built yet.
- **Inputs**: the planner's requests to the diff's routes are request templates (method, path and query, headers with no credential, body; never its `expected`, `purpose`, assertions or claims). The PR's text wins where it names a parameter or a field (kr-shop #9's planner copied `?items` from the bug). The base's answers are not passed yet. Its tokens count as `intent` in the metrics and the spend report.
- **Length**: `.length` on an array is its length (`$.length`, `$.items.length`); it counts a list, it never explains what is in it.
- **every** (two kinds added to the closed set): `$[*].item == "keyboard"`, one `[*]`, also nested (`$.items[*].sku`). An empty array fails unless the assertion sets `allowEmpty` (a filter with a seeded match is not met by an empty list). It explains an array's difference together with a length assertion on the same array, or alone when its sentence says "only" (kr-shop #10).
- **includes**: a path's string contains a literal; on `$`, any string of a JSON answer or a body that is not JSON. For a quoted message (kr-shop #13). It explains no field.
- **Rules of a route**: a `sameAs`, or a `computed` with no `$request` path, is a rule over the answer's fields. It may also explain another planned probe of the same method and route (`GET /orders/:id`, kr-shop #12), and there it never flags: a failure on a request it was not quoted for is not recorded.
- **A status that depends on the value** (v1l, #44): when the text gives one request shape several statuses (`sofa` refused with 400 `unknown item`, `keyboard` accepted with 201), a planned probe of that shape with another value is explained only by a refusal whose quoted message it also answers. A bare status lends nothing, and nothing is lent when a sentence of the route failed on its own request (a PR that refuses `keyboard` answers the refusal's message too).
- **What cannot be evaluated** (v1e): an expression with an absent or non-number operand, or a division by zero, is inconclusive: never a mismatch, never an explanation. On an answer the app refused (4xx), an assertion other than the status is inconclusive unless the probe asserts a 4xx itself (the refusal the text describes, #13); a 2xx the probe asserts is what fails. `$request.body.x` is refused at validation: `$request` already is the body.
- **Request values** (v1e, #28): a probe with an assertion other than a route rule only sends values its source gives. A value of a key the text names (a query parameter, a body field, a path parameter of the entry point) must be a whole token of the text; a key it does not name may also take a value of a request template (#13's `item`). Otherwise the probe is dropped with the reason.
- **Request shape** (v1e, #18): a held `status` also explains a planned probe of the same method, route, query keys and JSON body keys, values aside; it only explains. `equals` stays with its own request.
- **Added routes** (v1e, #20): on a route the diff adds, with every base round 404/405 after a ready check, the PR's answer under 500 is `new_endpoint` even when it is a 404/405 of its own (a missing order); 5xx stays `new_endpoint_error`.
- **Output**: one turn asks for 16 000 output tokens (the product lowers it to the Run's budget) and compact JSON; an answer that is not the JSON asked for is asked again once, inside the same step, both turns counted.
- **Steps**: `intent:author` after the plan, `phase:intent_probes` and the intent probes' rounds at the indexes after the plan's and the kept checks' (each keeps its index even when a planned twin plays it): a new `RUNTIME_RELEASE_VERSION`.

## Shown on the PR

A section "Not what the PR describes" lists each failed assertion: the quoted sentence, the request, and the expected and received values. A line counts the assertions that held. A described change is listed with its sentence.

## Done when

On a corpus of 20 bug/correct pairs (the 8 kr-shop PRs plus 12 more on kr-shop and kr-nextjs, same description on both sides): at least 3 of 4 bugs caught, 0 correct PRs flagged, and no regression the gate catches today lost.
