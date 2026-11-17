import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { riskCriteriaSchema } from '@libs/core/infrastructure/config/types/general/risk-assessment';
import { PreviewPrRiskDto } from './risk-assessment.dto';

it('keeps unsaved team guidance intact through the real API transformation', async () => {
    const input = {
        teamId: 'team',
        repositoryId: 'repo',
        prNumber: 42,
        criteria: [
            {
                id: 'access',
                name: 'Access',
                enabled: true,
                instructions: 'Check account isolation.',
                includedFiles: ['src/**/*.{ts,tsx}'],
            },
        ],
    };
    const result = await new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: true },
    }).transform(input, { type: 'body', metatype: PreviewPrRiskDto });
    expect(JSON.parse(JSON.stringify(result))).toEqual(input);
    expect(riskCriteriaSchema.safeParse(result.criteria).success).toBe(true);
});
