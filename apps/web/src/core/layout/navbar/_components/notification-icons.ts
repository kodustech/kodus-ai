import {
    BellIcon,
    CreditCardIcon,
    InfoIcon,
    ShieldAlertIcon,
    ZapIcon,
} from "lucide-react";

import type { CatalogIcon } from "@services/notifications/types";

/**
 * Single source of truth for catalog-icon-name → lucide-component
 * resolution. Used by the in-app drawer and the critical banner so the
 * navbar and any other consumer stay in sync with the catalog the
 * backend declares.
 */
export const NOTIFICATION_ICONS: Record<CatalogIcon, React.ElementType> = {
    "bell": BellIcon,
    "shield-alert": ShieldAlertIcon,
    "zap": ZapIcon,
    "info": InfoIcon,
    "credit-card": CreditCardIcon,
};

export const DEFAULT_NOTIFICATION_ICON: React.ElementType = BellIcon;

export const resolveNotificationIcon = (
    name: CatalogIcon | undefined,
): React.ElementType =>
    (name && NOTIFICATION_ICONS[name]) ?? DEFAULT_NOTIFICATION_ICON;
