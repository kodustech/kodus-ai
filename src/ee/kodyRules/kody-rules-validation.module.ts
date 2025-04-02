/**
 * @license
 * Kodus Tech. All rights reserved.
 */

import { Module } from '@nestjs/common';
import { KodyRulesValidationService } from './service/kody-rules-validation.service';

@Module({
    providers: [KodyRulesValidationService],
    exports: [KodyRulesValidationService],
})
export class KodyRulesValidationModule { }
