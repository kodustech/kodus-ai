import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    HttpStatus,
    Inject,
    Post,
    Query,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
    ApiBearerAuth,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';

import { CompleteCliLoginUseCase } from '@libs/identity/application/use-cases/cli-auth/complete-cli-login.use-case';
import { GetCliLoginInfoUseCase } from '@libs/identity/application/use-cases/cli-auth/get-cli-login-info.use-case';
import { InitiateCliDeviceLoginUseCase } from '@libs/identity/application/use-cases/cli-auth/initiate-cli-device-login.use-case';
import { InitiateCliLoginUseCase } from '@libs/identity/application/use-cases/cli-auth/initiate-cli-login.use-case';
import { PollCliLoginUseCase } from '@libs/identity/application/use-cases/cli-auth/poll-cli-login.use-case';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';

import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';

@ApiTags('CLI Auth')
@ApiStandardResponses()
@Controller('cli/auth')
export class CliAuthController {
    constructor(
        private readonly initiateCliLoginUseCase: InitiateCliLoginUseCase,
        private readonly initiateCliDeviceLoginUseCase: InitiateCliDeviceLoginUseCase,
        private readonly completeCliLoginUseCase: CompleteCliLoginUseCase,
        private readonly pollCliLoginUseCase: PollCliLoginUseCase,
        private readonly getCliLoginInfoUseCase: GetCliLoginInfoUseCase,
        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    @Post('login-init')
    @Public()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Initiate browser login (loopback)',
        description:
            'Called by the CLI. Opens a session bound to a localhost callback port; returns the verification URI the CLI should open in the browser plus the opaque state used to retrieve the token afterwards.',
    })
    @ApiOkResponse({
        description: 'verification_uri + state + expires_in',
    })
    async initiate(
        @Body() body: { port?: number },
        @Headers('user-agent') userAgent?: string,
    ) {
        if (!body?.port) {
            throw new BadRequestException('port is required');
        }
        return this.initiateCliLoginUseCase.execute({
            port: body.port,
            userAgent,
        });
    }

    @Post('device-init')
    @Public()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Initiate device-code login (headless fallback)',
        description:
            'Called by the CLI when no browser is available. Returns a user_code the user types into the web verification URI, and a device_code the CLI uses to poll for the token.',
    })
    @ApiOkResponse({
        description:
            'device_code + user_code + verification_uri + expires_in + interval',
    })
    async deviceInit(@Headers('user-agent') userAgent?: string) {
        return this.initiateCliDeviceLoginUseCase.execute({ userAgent });
    }

    @Get('login-info')
    @Public()
    @ApiOperation({
        summary: 'Read pending CLI auth session for confirmation UI',
        description:
            'Read-only endpoint the web /cli/authorize page hits to render confirmation UI (mode, expires, user-agent). Never returns the token or redirect URI. Public so the page renders even when the user has not completed login yet.',
    })
    async info(
        @Query('state') state?: string,
        @Query('user_code') userCode?: string,
    ) {
        return this.getCliLoginInfoUseCase.execute({ state, userCode });
    }

    @Post('login-complete')
    @ApiBearerAuth('jwt')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Finalize CLI auth session for the logged-in user',
        description:
            'Called by the web /cli/authorize page after the user clicks Authorize. Mints a JWT for the logged-in user and stores it on the session row so the CLI can fetch it via login-poll. Returns the loopback redirect URI when applicable.',
    })
    async complete(
        @Body() body: { state?: string; userCode?: string },
    ) {
        const user = this.request.user;
        if (!user?.uuid) {
            throw new BadRequestException('Authenticated user required');
        }
        return this.completeCliLoginUseCase.execute({
            state: body.state,
            userCode: body.userCode,
            user,
        });
    }

    @Get('login-poll')
    @Public()
    @ApiOperation({
        summary: 'Poll for completed CLI auth session',
        description:
            'Called by the CLI. Returns { status: "completed", accessToken, refreshToken } once the user authorizes; "pending" while waiting; "expired"/"denied"/"consumed" otherwise. Tokens are returned exactly once — the row is marked consumed on the first successful poll.',
    })
    async poll(
        @Query('state') state?: string,
        @Query('device_code') deviceCode?: string,
    ) {
        return this.pollCliLoginUseCase.execute({ state, deviceCode });
    }
}
