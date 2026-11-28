/** Comments the review pipeline posts on a PR, shared by the stages that post them. */

import { KODY_IDENTIFIERS } from '@libs/common/utils/kody-identifiers';
import { PlatformType } from '@libs/core/domain/enums';

/** A comment body with Kody's signature. Bitbucket renders an HTML comment as
 *  text, so there the body opens with the chip Kody's other Bitbucket comments
 *  carry; every other platform gets the HTML comment at the end. */
export const kodyCommentBody = (
    body: string,
    platformType: PlatformType,
): string =>
    platformType === PlatformType.BITBUCKET
        ? `\`${KODY_IDENTIFIERS.MARKDOWN_IDENTIFIERS.BITBUCKET}\`\n\n${body}`
        : `${body}\n\n<!-- ${KODY_IDENTIFIERS.MARKDOWN_IDENTIFIERS.DEFAULT} -->`;

/** A review skipped because the model it runs on is routed by Kodus and the
 *  organization's prepaid credits are used up. */
export const KODUS_CREDITS_EXHAUSTED_COMMENT =
    '## Your Kodus credits are used up 💳\n\n' +
    'This repository reviews with a model routed by Kodus, and your ' +
    "organization's prepaid credit balance is at zero.\n\n" +
    '**[Top up credits](https://app.kodus.io/byok#kodus)** ' +
    'and re-run the review (or push a new commit) — or ' +
    '[connect your own AI key](https://app.kodus.io/byok) to review ' +
    'on your provider account instead.';
