import { Module } from '@nestjs/common';

import { PricingController } from './pricing/pricing.controller';
import { PricingService } from './pricing/pricing.service';
import { UsersController } from './users/users.controller';

@Module({
    controllers: [PricingController, UsersController],
    providers: [PricingService],
})
export class AppModule {}
