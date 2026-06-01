import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';

import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import {
    VersionCheckService,
    VersionStatus,
} from '../services/version-check.service';

/**
 * System-level endpoints not tied to a specific feature/domain.
 *
 * Public on purpose: the response carries no organization data, just
 * the running RELEASE_VERSION and the latest self-hosted release on
 * GitHub. The web layout calls this server-side to decide whether to
 * render the update banner; making it public avoids dragging an auth
 * dependency into the layout's shell.
 */
@ApiTags('System')
@ApiStandardResponses({ includeAuth: false })
@Public()
@Controller('system')
export class SystemController {
    constructor(private readonly versionCheck: VersionCheckService) {}

    @Get('version-status')
    async versionStatus(): Promise<VersionStatus> {
        return this.versionCheck.getStatus();
    }
}
