import { Body, Controller, Headers, HttpCode, Post, Res, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import { RuntimeLlmGatewayUseCase } from '@libs/runtime/api/application/use-cases/llm-gateway.use-case';
import { RuntimeRecipeAuthorUseCase } from '@libs/runtime/api/application/use-cases/recipe-author.use-case';
import { RuntimeSetupRepoTokensUseCase } from '@libs/runtime/api/application/use-cases/setup-repo-tokens.use-case';
import { RuntimeTestPlannerUseCase } from '@libs/runtime/api/application/use-cases/test-planner.use-case';
import { RuntimeModelTurnGatewayUseCase } from '@libs/runtime/api/application/use-cases/model-turn-gateway.use-case';
import { RuntimePlannerSourceUseCase } from '@libs/runtime/api/application/use-cases/planner-source.use-case';

/**
 * POST /internal/runtime/llm — the LLM gateway of the Runtime (ADR-057), and
 * POST /internal/runtime/recipe-author — Kody writes a setup's recipe, the
 * agent running here with the org's key, and POST /internal/runtime/plan —
 * Kody plans a Run's probes (ADR-069), the same way, and POST
 * /internal/runtime/setup-repo-tokens — new download tokens for the next boot
 * of a setup. Not user routes: the only credential
 * is the Run or setup token the product signed (`Authorization: Bearer
 * <token>`), checked by each use case, hence @Public.
 */
@ApiExcludeController()
@Public()
@Controller('internal/runtime')
export class RuntimeLlmGatewayController {
    constructor(
        private readonly gateway: RuntimeLlmGatewayUseCase,
        private readonly recipeAuthor: RuntimeRecipeAuthorUseCase,
        private readonly testPlanner: RuntimeTestPlannerUseCase,
        @Optional() private readonly modelTurn?: RuntimeModelTurnGatewayUseCase,
        @Optional() private readonly plannerSource?: RuntimePlannerSourceUseCase,
        @Optional() private readonly setupRepoTokens?: RuntimeSetupRepoTokensUseCase,
    ) {}

    @Post('llm')
    @HttpCode(200)
    // The body's schema is the gateway's own (RuntimeLlmRequestSchema, strict):
    // validated by the use case after the Run token, not by a DTO here.
    completeForRun(@Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
        return this.gateway.execute({ authorization, body });
    }

    @Post('recipe-author')
    @HttpCode(200)
    // Body: RecipeAuthorRequestSchema (strict), validated by the use case after the setup token.
    authorRecipe(
        @Headers('authorization') authorization: string | undefined,
        @Body() body: unknown,
        @Res({ passthrough: true }) res: { once(event: 'close', listener: () => void): unknown; readonly writableEnded: boolean },
    ) {
        // The agent runs up to 5 minutes: when the worker's request closes before the answer, the run stops with it.
        const gone = new AbortController();
        res.once('close', () => {
            if (!res.writableEnded) gone.abort();
        });
        return this.recipeAuthor.execute({ authorization, body, signal: gone.signal });
    }

    @Post('setup-repo-tokens')
    @HttpCode(200)
    // Body: SetupRepoTokensBodySchema (strict), validated by the use case after the setup token.
    refreshSetupRepoTokens(@Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
        if (!this.setupRepoTokens) throw new ServiceUnavailableException('Runtime setup repository tokens unavailable');
        return this.setupRepoTokens.execute({ authorization, body });
    }

    @Post('plan')
    @HttpCode(200)
    // Body: RunPlanRequestSchema (strict), validated by the use case after the Run token.
    planRun(
        @Headers('authorization') authorization: string | undefined,
        @Body() body: unknown,
        @Res({ passthrough: true }) res: { once(event: 'close', listener: () => void): unknown; readonly writableEnded: boolean },
    ) {
        // When the worker's request closes before the answer, the round stops with it.
        const gone = new AbortController();
        res.once('close', () => {
            if (!res.writableEnded) gone.abort();
        });
        return this.testPlanner.execute({ authorization, body, signal: gone.signal });
    }
    @Post('model-turn')
    @HttpCode(200)
    completeModelTurn(
        @Headers('authorization') authorization: string | undefined,
        @Headers('x-runtime-sealed-token') sealedToken: string | undefined,
        @Body() body: unknown,
        @Res({ passthrough: true }) res: { once(event: 'close', listener: () => void): unknown; readonly writableEnded: boolean },
    ) {
        if (!this.modelTurn) throw new ServiceUnavailableException('Runtime model gateway unavailable');
        const gone = new AbortController();
        res.once('close', () => { if (!res.writableEnded) gone.abort(); });
        return this.modelTurn.execute({ authorization, sealedToken, body, signal: gone.signal });
    }

    @Post('planner-source')
    @HttpCode(200)
    readPlannerSource(@Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
        if (!this.plannerSource) throw new ServiceUnavailableException('Runtime planner source unavailable');
        return this.plannerSource.execute({ authorization, body });
    }

}
