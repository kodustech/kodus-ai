import {
    Body,
    Controller,
    Get,
    Header,
    Headers,
    HttpCode,
    NotFoundException,
    Post,
    Req,
    StreamableFile,
    UseGuards,
} from '@nestjs/common';
import { AgentCard } from '@a2a-js/sdk';
import { ApiExcludeController } from '@nestjs/swagger';

import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import { kodyRuntimeEnabledInThisProcess } from '@libs/runtime-publish/runtime-feature';
import { RuntimeA2AAdapter } from '@libs/runtime/api/infrastructure/a2a/runtime-a2a.adapter';
import {
    RuntimeA2ABearerGuard,
    type RuntimeA2ARequest,
} from '@libs/runtime/api/infrastructure/a2a/runtime-a2a.guard';
import { RuntimeReleaseGuard } from './runtime-release.guard';

@ApiExcludeController()
@Public()
@Controller()
export class RuntimeA2AController {
    constructor(private readonly adapter: RuntimeA2AAdapter) {}

    // Public, so it never announces the Runtime where the deployment does not run it.
    @Get('.well-known/agent-card.json')
    card() {
        if (!kodyRuntimeEnabledInThisProcess()) throw new NotFoundException();
        return this.jsonResponse(AgentCard.toJSON(this.adapter.card()));
    }

    @Post('runtime/a2a')
    @HttpCode(200)
    @Header('Cache-Control', 'private, no-store')
    // The bearer guard sets the org; the release guard then asks for it.
    @UseGuards(RuntimeA2ABearerGuard, RuntimeReleaseGuard)
    async rpc(
        @Req() req: RuntimeA2ARequest,
        @Body() body: unknown,
        @Headers('a2a-version') version: string | undefined,
    ) {
        return this.jsonResponse(
            await this.adapter.rpc(req.runtimeA2APrincipal!, body, version),
        );
    }

    private jsonResponse(value: unknown): StreamableFile {
        // Protocol responses must bypass the product's REST envelope.
        return new StreamableFile(Buffer.from(JSON.stringify(value)), {
            type: 'application/json',
        });
    }
}
