import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';

import { isBotUser } from '@libs/common/utils/bot-user';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@libs/identity/domain/user/contracts/user.service.contract';

import { NotificationRecipient } from '../domain/recipient';

export interface PrAuthorRef {
    /** Platform username/login. Used for bot filtering. */
    login?: string | null;
    /** Email when the platform provides it. */
    email?: string | null;
}

/**
 * Resolves a PR author into a notification recipient.
 *
 * Returns null when:
 *  - the author is a bot (dependabot/renovate/etc.),
 *  - the author has no email available,
 *  - or no active internal user matches by email in the org.
 *
 * The "skip if no matching user" semantics are deliberate: PR-related
 * notifications target our product's users; external contributors don't
 * expect product email from us and aren't reachable via the in-app
 * channel anyway. Callers that get `null` should simply skip the emit.
 */
@Injectable()
export class PrAuthorRecipientResolver {
    private readonly logger = createLogger(PrAuthorRecipientResolver.name);

    constructor(
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,
    ) {}

    async resolve(
        author: PrAuthorRef,
        organizationId: string,
    ): Promise<NotificationRecipient | null> {
        if (!author?.email) return null;
        if (isBotUser(author.login)) return null;

        const users = await this.usersService.find(
            { email: author.email, organization: { uuid: organizationId } },
            [STATUS.ACTIVE],
        );
        if (!users?.length) {
            this.logger.debug({
                message:
                    'PR author has no matching internal user — skipping notification',
                context: PrAuthorRecipientResolver.name,
                metadata: {
                    authorEmail: author.email,
                    authorLogin: author.login,
                    organizationId,
                },
            });
            return null;
        }

        return { kind: 'user', userId: users[0].uuid };
    }
}
