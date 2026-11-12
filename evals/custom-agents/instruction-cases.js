// P12 repository instruction files: with repository instructions on, the
// review loads the coding-agent instruction files (CLAUDE.md, AGENTS.md) from
// the target branch and hands them to every agent. A custom agent that
// enforces the conventions written there posts the violation it finds,
// quoting the file, and stays quiet on the same change done right. No guide
// is linked to the agent.
// Invented domain: a bike-rental team.

const AGENT_ID = 'agent-rental-conventions';

const CLAUDE_MD = `# Working in this repository

## Pricing

- Rental prices are computed by PricingService; controllers never apply discounts themselves.
- Prices are integer cents.
`;

const REPO = {
    'CLAUDE.md': CLAUDE_MD,
    'src/pricing/pricing.service.ts': `export interface Rental {
    id: string;
    hours: number;
    memberTier: 'basic' | 'gold';
}

export class PricingService {
    /** Price in cents, with the member's discount applied. */
    async priceFor(rental: Rental): Promise<number> {
        const base = rental.hours * 400;
        return rental.memberTier === 'gold' ? Math.floor((base * 90) / 100) : base;
    }
}
`,
};

const CONTROLLER_BEFORE = `import { PricingService, Rental } from '../pricing/pricing.service';

export class RentalsController {
    constructor(private readonly pricing: PricingService) {}

    async quote(rental: Rental) {
        return { priceCents: await this.pricing.priceFor(rental) };
    }
}
`;

const agent = {
    id: AGENT_ID,
    name: 'Rental conventions',
    enabled: true,
    instructions: `Review the change against the team's conventions written in the repository's instruction files (CLAUDE.md, AGENTS.md).
Report only what a rule there forbids, and quote the rule.`,
    scope: {},
    tools: {},
    presentation: {
        tag: { color: '#2563eb' },
        format: 'inline',
        suggestedFix: 'when-confident',
    },
};

const PRICING = /PricingService|discount|pricing/i;

const INSTRUCTION_CASES = [
    {
        id: 'instructions-rule-violated',
        checks: 'An agent enforcing CLAUDE.md flags a controller that applies a weekend discount itself, quoting the file',
        team: { agent, repoInstructionsEnabled: true },
        prTitle: 'Weekend discount',
        prBody: 'Rentals that start on a weekend get 15% off.',
        before: { 'src/rentals/rentals.controller.ts': CONTROLLER_BEFORE },
        repo: {
            ...REPO,
            'src/rentals/rentals.controller.ts': `import { PricingService, Rental } from '../pricing/pricing.service';

export class RentalsController {
    constructor(private readonly pricing: PricingService) {}

    async quote(rental: Rental, startsAt: Date) {
        let priceCents = await this.pricing.priceFor(rental);
        const weekend = startsAt.getDay() === 0 || startsAt.getDay() === 6;
        if (weekend) priceCents = Math.floor((priceCents * 85) / 100);
        return { priceCents };
    }
}
`,
        },
        expect: [
            {
                property: 'P12',
                flag: 'src/rentals/rentals.controller.ts',
                at: 'if (weekend) priceCents = Math.floor((priceCents * 85) / 100);',
                about: PRICING,
            },
        ],
    },
    {
        id: 'instructions-rule-followed',
        checks: 'The same agent stays quiet when the weekend discount lives in PricingService (control)',
        team: { agent, repoInstructionsEnabled: true },
        prTitle: 'Weekend discount',
        prBody: 'Rentals that start on a weekend get 15% off.',
        before: {
            'src/rentals/rentals.controller.ts': CONTROLLER_BEFORE,
            'src/pricing/pricing.service.ts':
                REPO['src/pricing/pricing.service.ts'],
        },
        repo: {
            ...REPO,
            'src/pricing/pricing.service.ts': `export interface Rental {
    id: string;
    hours: number;
    memberTier: 'basic' | 'gold';
}

export class PricingService {
    /** Price in cents, with the member's and the weekend discount applied. */
    async priceFor(rental: Rental, startsAt?: Date): Promise<number> {
        const base = rental.hours * 400;
        const member = rental.memberTier === 'gold' ? Math.floor((base * 90) / 100) : base;
        const weekend = startsAt && (startsAt.getDay() === 0 || startsAt.getDay() === 6);
        return weekend ? Math.floor((member * 85) / 100) : member;
    }
}
`,
            'src/rentals/rentals.controller.ts': `import { PricingService, Rental } from '../pricing/pricing.service';

export class RentalsController {
    constructor(private readonly pricing: PricingService) {}

    async quote(rental: Rental, startsAt: Date) {
        return { priceCents: await this.pricing.priceFor(rental, startsAt) };
    }
}
`,
        },
        expect: [
            {
                property: 'P12',
                quiet: 'src/rentals/rentals.controller.ts',
                about: PRICING,
            },
        ],
    },
];

module.exports = { INSTRUCTION_CASES };
