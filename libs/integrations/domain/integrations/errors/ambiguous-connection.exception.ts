import { BadRequestException } from '@nestjs/common';

/**
 * A connect call that names no connection while several of the provider's
 * could be the one meant. Providers pass it through as is: it is not a bad
 * token, and its message tells the user what to do.
 */
export class AmbiguousConnectionException extends BadRequestException {
    constructor() {
        super(
            'This workspace has several connections to this provider: reconnect one from its card in Settings > Git.',
        );
    }
}
