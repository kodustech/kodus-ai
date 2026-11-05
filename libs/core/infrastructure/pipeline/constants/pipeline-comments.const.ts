/** Comments the review pipeline posts on a PR, shared by the stages that post them. */

/** A review skipped because the model it runs on is routed by Kodus and the
 *  organization's prepaid credits are used up. */
export const KODUS_CREDITS_EXHAUSTED_COMMENT =
    '## Your Kodus credits are used up 💳\n\n' +
    'This repository reviews with a model routed by Kodus, and your ' +
    "organization's prepaid credit balance is at zero.\n\n" +
    '**[Top up credits](https://app.kodus.io/byok#kodus)** ' +
    'and re-run the review (or push a new commit) — or ' +
    '[connect your own AI key](https://app.kodus.io/byok) to review ' +
    'on your provider account instead.\n\n' +
    '<!-- kody-codereview -->';
