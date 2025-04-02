import { PlatformType } from '../enums/platform-type.enum';

export class IDataPoint {
    content: string;
    timestamp: Date;
    sender: string;
    platform: PlatformType;
}
