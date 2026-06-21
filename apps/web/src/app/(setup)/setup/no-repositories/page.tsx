"use client";

import { redirect, useRouter } from "next/navigation";
import { Avatar, AvatarImage } from "@components/ui/avatar";
import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
import { SvgKodus } from "@components/ui/icons/SvgKodus";
import { Page } from "@components/ui/page";
import { useSuspenseGetCodeReviewParameter } from "@services/parameters/hooks";
import { ArrowLeftIcon } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import { StepIndicators } from "../_components/step-indicators";

export default function App() {
    const router = useRouter();
    const { teamId } = useSelectedTeamId();
    const { configValue } = useSuspenseGetCodeReviewParameter(teamId);

    if (configValue?.repositories?.length) {
        redirect("/setup/review-mode");
    }

    return (
        <Page.Root className="mx-auto flex min-h-full w-full flex-row p-6">
            <div className="bg-card-lv1 flex flex-10 flex-col justify-center gap-10 rounded-3xl p-12">
                <div className="text-text-secondary flex flex-1 flex-col justify-center gap-8 text-[15px]">
                    <div className="flex flex-col gap-4">
                        <svg
                            width="34"
                            height="30"
                            viewBox="0 0 34 30"
                            fill="none"
                            xmlns="http://www.w3.org/2000/svg">
                            <path
                                fill="#6A57A4"
                                fillOpacity="0.2"
                                d="M23.2503 29.5833C22.1453 29.5833 21.0855 29.1443 20.3041 28.3629C19.5226 27.5815 19.0837 26.5217 19.0837 25.4166V12.9166C19.0837 6.39575 22.5212 2.09784 28.9941 0.479084C29.2602 0.410395 29.5373 0.395037 29.8093 0.433901C30.0814 0.472763 30.3431 0.565081 30.5794 0.705526C30.8156 0.845974 31.0217 1.03178 31.1859 1.25223C31.35 1.47269 31.4689 1.72344 31.5356 1.99004C31.6024 2.25664 31.6158 2.53382 31.575 2.80561C31.5342 3.07741 31.44 3.33844 31.2979 3.57368C31.1558 3.80891 30.9685 4.0137 30.7469 4.17624C30.5252 4.33879 30.2736 4.45587 30.0066 4.52075C25.367 5.68117 23.2503 8.327 23.2503 12.9166V14.9999H29.5003C30.5515 14.9996 31.564 15.3966 32.3348 16.1114C33.1056 16.8261 33.5777 17.8058 33.6566 18.8541L33.667 19.1666V25.4166C33.667 26.5217 33.228 27.5815 32.4466 28.3629C31.6652 29.1443 30.6054 29.5833 29.5003 29.5833H23.2503ZM4.50033 29.5833C3.39526 29.5833 2.33545 29.1443 1.55405 28.3629C0.772652 27.5815 0.333664 26.5217 0.333664 25.4166V12.9166C0.333664 6.39575 3.77116 2.09784 10.2441 0.479084C10.5102 0.410395 10.7873 0.395037 11.0594 0.433901C11.3314 0.472763 11.5931 0.565081 11.8294 0.705526C12.0656 0.845974 12.2717 1.03178 12.4359 1.25223C12.6 1.47269 12.7189 1.72344 12.7856 1.99004C12.8524 2.25664 12.8658 2.53382 12.825 2.80561C12.7842 3.07741 12.69 3.33844 12.5479 3.57368C12.4058 3.80891 12.2185 4.0137 11.9969 4.17624C11.7752 4.33879 11.5236 4.45587 11.2566 4.52075C6.617 5.68117 4.50033 8.327 4.50033 12.9166V14.9999H10.7503C11.8015 14.9996 12.814 15.3966 13.5848 16.1114C14.3556 16.8261 14.8277 17.8058 14.9066 18.8541L14.917 19.1666V25.4166C14.917 26.5217 14.478 27.5815 13.6966 28.3629C12.9152 29.1443 11.8554 29.5833 10.7503 29.5833H4.50033Z"
                            />
                        </svg>

                        <p>
                            Kodus has had a huge impact on our workflow by
                            saving us valuable time during PR reviews. It
                            consistently catches the small details that are easy
                            to miss, and the ability to set up custom rules
                            means we can align automated reviews with our own
                            standards. This has helped us maintain higher
                            quality while reducing the manual burden on the
                            team.
                        </p>
                        <p>
                            Since we started using it,{" "}
                            <strong className="text-success">
                                our code review time dropped by 40%
                            </strong>
                            , and production bugs were reduced by half.
                        </p>
                    </div>

                    <div className="flex flex-row gap-4">
                        <Avatar>
                            <AvatarImage src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADIAAAAxCAMAAACvdQotAAAAtFBMVEUILEoGJkEMDw4/LCIKFyAdHBdsQTYEc4xAkKYTjZEwHhgJHjB1pLYLZ3p2e4NuUkWIqrs8OjwzMDBub3EZgpQvUGNIU1ojRFyPlJq6ur1ZLSONX1AKPFfDm46mfHJISElWlqe5i3lwY2EJZqZLcouWbl+hn6absbtXOyxqmrfVrqKMiJBAhKllXI4zdZiqs743W3I3bITfvbMGWWmeRi9ujJujOCllEQ21rLlOhYaojYmAZJxguYrKAAAEm0lEQVRIx23Vi3aiOhQG4GAgUkDCRQFBuWREYrFeRtuxzvu/19k7gGjn/K1rVoWPncsmQ05RUbDr9et6ZSLcHvem422jcFldRSTCNkm2XZLP7yFkOp2dFhGq65W7I/niAODepjTLcrcr3x4h5nw+n85mp4jzK2+X+z0SoUiSJO3Wg8vTabnbf+/3m83mvDmTZj83TbNTBVSZO94NybUnDZJ503xgzmDOxDucD/udOUdViGa/L5ttUYhCFmELgdmheRmYd1hsgJiNOZ1F4RFI6AeWAfGLogiT7V/1/M3hcIBxbU4fH0i+Pcc0lz05+FYQoDCCwAr8cPu3y8cjSFwkRyAFkDjwA2OCAWUZlru83W7HWxe13GpgTyQKgmDyFCM8Nk3j9VliiLd5Iq6LY4IbLQilljExYpjEryH74/LYEWfXkSjyLQQyy+p8DcnlRPv1HAerOFgFFlmtWKFKsDqv1u+/MevC2Oxg8yFlWcIGwHSIc34lxiTNRvJeWeHyKbcWVuyFRLCykndEmfd1EJddlZ0DaZr/qSI5EBR9GU6e5wLzXz6Ip4hucSBQBA2g23vlt10+Ie7n9qbI2XlUmRSCsYAGXOT3mvlc1Ln8GnLFT94TZyQF7AlV+04p5bXg9M9z2F2Rw4MI6Ba1i5ZBMyktyhmvKQ1AU9xay5J5/kIKlnKJ1ziTGWxkVtc8z0OMgF8hIt/Pvl5JmhZcSsazjGXr93VVwTrkSZ/WdcVIvHKowoTAbckYq6uqxnVbH4/NET6e8+lClfonYVxAf1W5pAalWZ0h+TadJvk8zN8UyV9JxGBTcCuz1LC45PesXq/by7xM3NNq1pMrtuXB60ksagkzZyyllGE3c1atXSDtSO5XbP79SDguFjMMmsIaMCZpVYVjlfCZdA0TizaQUnKZWrJe/77zKqvy1eVtN5CiH9gFBmZOvRJIeCyohOZnDFsTGq3KMyBO4i6QCKYIHFIHc2dOnY5EBrUkbDxMBZszz/m/ZAbH5xQPxDmSZQjvPWUyxeYQsDPcH8hFkQDIdMxsIVwBp4pFU8ngvanXFadB/FKF5hmJMCeVRRRPAgtPIgubpoZXJ9DjV+K3GVEtneJPmlJicDoce+qU1fXohQT+PSPY6dYfS7W8b9vFcPDp+NF1P3wiYUcul0scxys4JP1Yg3sonTyQDoelO5ISSVITPP7xf6XzKSYaPNoYDfxh/yAUCZQ4nQ/nkxL2RBmjB9LX483iB8lhLj7cjmNbEXsw3dRYLmwNVmzu9cQF0uakiOD5ZLVadQZnPaHQydCY8JIFNl7ajCRwcwIVSJ8VTkYhim8ziHVhqyuLgaRIYrhRI1qvcAEQwXGEbdkRuGPxTGzN1rQR2d1+THxXvfdB97WmxU9E121lhmvK2LAQfnT/3eLXNlTSyEDCrSKdUQpMVwbTRho+w8YL8UCWiuiDgPFh4CE2fm0TTT1ODeBiOg+i43M0dTdRU+qqwT/jkFeEnL3tSGDXtR4RrTedt8kwy5W2aRKXp4FY4u7B77Bs6uGPFdds0mOosnJdJEVLdDVqTe/HMIy8c3Ynu30WbnhNA0v+B9jfygApYtqLAAAAAElFTkSuQmCC" />
                        </Avatar>

                        <div>
                            <strong>Leonardo Maia</strong>
                            <p>Conta Voltz</p>
                        </div>
                    </div>
                </div>
            </div>

            <div className="flex flex-14 flex-col items-center justify-center gap-10 p-10">
                <div className="flex max-w-96 flex-1 flex-col justify-center gap-10">
                    <StepIndicators.Auto errorStepIndex={3} />

                    <div className="flex flex-col gap-8">
                        <Heading variant="h2">No repositories found</Heading>

                        <div className="text-text-secondary space-y-4 text-sm">
                            <p className="flex flex-col gap-2">
                                Possible reasons:
                            </p>

                            <ul className="flex list-inside list-disc flex-col gap-2">
                                <li>
                                    you don’t have the required permissions to
                                    install Kodus in this organization
                                </li>

                                <li>
                                    there are no repositories in this
                                    organization
                                </li>
                            </ul>
                        </div>
                    </div>

                    <Button
                        size="sm"
                        variant="helper"
                        leftIcon={<ArrowLeftIcon />}
                        onClick={() => {
                            router.push("/setup/connecting-git-tool");
                        }}>
                        Try again
                    </Button>
                </div>
            </div>
        </Page.Root>
    );
}
