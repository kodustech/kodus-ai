import { createContext, useContext } from "react";

const subscriptionStatusContext = createContext({
    isBYOK: false,
    isTrial: false,
    isEnterprise: false,
});

export const SubsciptionStatusProvider = ({
    children,
    isBYOK = false,
    isTrial = false,
    isEnterprise = false,
}: React.PropsWithChildren & {
    isBYOK: boolean;
    isTrial: boolean;
    isEnterprise: boolean;
}) => {
    return (
        <subscriptionStatusContext.Provider
            value={{ isBYOK, isTrial, isEnterprise }}>
            {children}
        </subscriptionStatusContext.Provider>
    );
};

export const useSubscriptionStatus = () => {
    return useContext(subscriptionStatusContext);
};
