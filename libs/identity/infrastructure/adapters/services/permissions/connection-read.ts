import { ForbiddenException } from '@nestjs/common';

import { ConnectionRestriction } from './connection-access.service';

/** Refuses a Git connection the member is not granted. */
export const assertConnectionReadable = (
    restriction: ConnectionRestriction | null | undefined,
    connectionId?: string,
): void => {
    if (
        restriction &&
        connectionId &&
        !restriction.connectionIds.has(connectionId)
    ) {
        throw new ForbiddenException(
            'You are not granted this Git connection of the workspace.',
        );
    }
};

/** The connections a member may read, or undefined when every one. */
export const readableConnectionIds = (
    restriction: ConnectionRestriction | null | undefined,
): string[] | undefined =>
    restriction ? [...restriction.connectionIds] : undefined;
