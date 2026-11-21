import { Injectable, NotFoundException } from '@nestjs/common';

const PRICES: Record<string, number> = { 'sku-1': 1000, 'sku-2': 2500 };

@Injectable()
export class PricingService {
    quote(sku: string, qty: number) {
        const unitCents = PRICES[sku];
        if (unitCents === undefined) throw new NotFoundException(`unknown sku ${sku}`);
        const discount = qty >= 5 ? 0.15 : 0;
        const totalCents = Math.round(unitCents * qty * (1 - discount));
        return { sku, qty, unitCents, discount, totalCents };
    }
}
