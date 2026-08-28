import type { SessionV1 } from "@labring/sealos-desktop-sdk";
import * as yaml from "js-yaml";
import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

type SessionState = {
  session: SessionV1;
  locale: string;
  setSession: (ss: SessionV1) => void;
  getKubeconfig: () => string;
  getNamespace: () => string;
};

const useSessionStore = create<SessionState>()(
  devtools(
    persist(
      immer((set, get) => ({
        session: {} as SessionV1,
        locale: "zh",
        setSession: (ss: SessionV1) => set({ session: ss }),
        getKubeconfig: () => {
          return get().session?.kubeconfig || "";
        },
        getNamespace: () => {
          if (!get().session?.kubeconfig) {
            return "";
          }
          const doc = yaml.load(get().session.kubeconfig);
          // @ts-ignore
          return doc?.contexts[0]?.context?.namespace;
        },
      })),
      {
        name: "sealaf-session",
        version: 1,
      },
    ),
  ),
);

export default useSessionStore;
