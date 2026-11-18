import { Controller, Get, Query } from '@nestjs/common';

import { PricingService } from './pricing.service';

@Controller('pricing')
export class PricingController {
    constructor(private readonly pricing: PricingService) {}

    @Get('quote')
    quote(@Query('sku') sku: string, @Query('qty') qty: string) {
        return this.pricing.quote(sku, Number(qty ?? 1));
    }
}
