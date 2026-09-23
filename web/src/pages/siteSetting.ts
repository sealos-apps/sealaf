import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

import { TSetting } from "@/apis/typing";
import { SettingControllerGetSettings } from "@/apis/v1/settings";

type SITE_KEY =
  | "site_footer"
  | "site_url"
  | "ai_pilot_url"
  | "ai_complete_url"
  | "laf_external_links_enabled"
  | "laf_forum_url"
  | "laf_business_url"
  | "laf_discord_url"
  | "laf_wechat_url"
  | "laf_doc_url"
  | "laf_about_us_url";

type State = {
  siteSettings: {
    // eslint-disable-next-line no-unused-vars
    [key in SITE_KEY]?: TSetting;
  };
  getSiteSettings: () => void;
};

export const selectExternalLinksEnabled = (state: State) =>
  state.siteSettings.laf_external_links_enabled?.value === "true";

const useSiteSettingStore = create<State>()(
  devtools(
    persist(
      immer((set, get) => ({
        siteSettings: {},
        getSiteSettings: async () => {
          const settings = await SettingControllerGetSettings({});
          set((state) => {
            // convert array to object
            state.siteSettings = settings.data.reduce(
              (acc: { [x: string]: TSetting }, cur: TSetting) => {
                acc[cur.key] = cur;
                return acc;
              },
              {} as Record<string, TSetting>,
            );
          });
        },
      })),

      {
        name: "laf_site_settings",
        version: 1,
      },
    ),
  ),
);

export default useSiteSettingStore;
