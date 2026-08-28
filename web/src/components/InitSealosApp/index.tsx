// components/SealosProvider.tsx
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { EVENT_NAME } from "@labring/sealos-desktop-sdk";
import type { SessionV1 } from "@labring/sealos-desktop-sdk";
import { createSealosApp, sealosApp } from "@labring/sealos-desktop-sdk/app";

import useSessionStore from "@/pages/auth/store";

const InitSealosApp = () => {
  const { i18n } = useTranslation();
  const { setSession } = useSessionStore();

  const handleI18nChange = (data: { currentLanguage: string }) => {
    const currentLng = i18n.resolvedLanguage;
    const newLng = data.currentLanguage;
    if (currentLng !== newLng) {
      i18n.changeLanguage(newLng);
    }
  };

  const initLang = async () => {
    const lang = await sealosApp.getLanguage();
    const lng = lang.lng;
    if (i18n.resolvedLanguage !== lng) {
      i18n.changeLanguage(lng);
    }
  };

  const initApp = async () => {
    const sealosUser = import.meta.env.VITE_SEALOS_MOCK_USER;
    const sealosKc = import.meta.env.VITE_SEALOS_MOCK_KC;

    if (sealosUser && sealosKc) {
      const testSession: SessionV1 = {
        user: {
          id: "",
          name: sealosUser,
          avatar: "",
          k8sUsername: "",
          nsid: "",
        },
        subscription: {
          ID: "",
          PlanName: "",
          Workspace: "",
          RegionDomain: "",
          UserUID: "",
          Status: "",
          PayStatus: "",
          PayMethod: "",
          Stripe: null,
          TrafficStatus: "",
          CurrentPeriodStartAt: "",
          CurrentPeriodEndAt: "",
          CancelAtPeriodEnd: false,
          CancelAt: "",
          CreateAt: "",
          UpdateAt: "",
          ExpireAt: null,
          Traffic: null,
          type: "PAYG",
        },
        kubeconfig: sealosKc,
      };
      setSession(testSession);
      return;
    }

    const result = await sealosApp.getSession();

    setSession(result);
  };

  useEffect(() => {
    const cleanupApp = createSealosApp();
    let cleanupEventListener: (() => void) | undefined;

    // handle iframe focus
    const handleIframeFocus = () => {
      const iframes = document.querySelectorAll("iframe");
      iframes.forEach((iframe) => {
        iframe.style.pointerEvents = "auto";
      });
    };

    // handle iframe visibility change
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        handleIframeFocus();
      }
    };

    const setup = async () => {
      try {
        window.addEventListener("blur", handleIframeFocus);
        document.addEventListener("visibilitychange", handleVisibilityChange);

        cleanupEventListener = sealosApp?.addAppEventListen(
          EVENT_NAME.CHANGE_I18N,
          handleI18nChange,
        );

        handleIframeFocus();

        await initLang();
        await initApp();
      } catch (error) {
        if (error instanceof Error) {
          // eslint-disable-next-line no-console
          console.error("Sealos app init error:", error.message);
        } else {
          // eslint-disable-next-line no-console
          console.error("Sealos app init error:", error);
        }
      }
    };

    setup().finally(() => {
      // eslint-disable-next-line no-console
      console.info("##### sealos app and sealos info init success #####");
    });

    return () => {
      window.removeEventListener("blur", handleIframeFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);

      if (cleanupEventListener && typeof cleanupEventListener === "function") {
        cleanupEventListener();
      }
      if (cleanupApp && typeof cleanupApp === "function") {
        cleanupApp();
      }
    };
  }, []);

  return null;
};

export default InitSealosApp;
