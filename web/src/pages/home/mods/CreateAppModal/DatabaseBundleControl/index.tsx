import { useTranslation } from "react-i18next";
import {
  Slider,
  SliderFilledTrack,
  SliderMark,
  SliderThumb,
  SliderTrack,
  useColorMode,
} from "@chakra-ui/react";
import clsx from "clsx";
import _, { find } from "lodash";

import { TextIcon } from "@/components/CommonIcon";
import { COLOR_MODE } from "@/constants";

import { TypeBundle } from "..";

export default function DatabaseBundleControl(props: {
  bundle: TypeBundle;
  originReplicas?: number;
  originCapacity?: number;
  resourceOptions: any;
  type: "create" | "change";
  defaultDedicatedDatabaseBundle?: any;
  onBundleItemChange: (k: string, v?: number) => any;
}) {
  const { bundle, onBundleItemChange, resourceOptions, originCapacity, originReplicas } = props;
  const { t } = useTranslation();
  const darkMode = useColorMode().colorMode === COLOR_MODE.dark;

  const buildSlider = (props: {
    type: string;
    specs: { value: number }[];
    value?: number;
    min?: number;
    onChange: (value: number) => void;
  }) => {
    const { type, specs, value, onChange, min } = props;
    const idx = specs.findIndex((spec) => spec.value === value);
    const handleChange = (index: number) => {
      const spec = specs[index];
      if (!spec || (min !== undefined && spec.value < min)) return;
      onChange(spec.value);
    };

    return (
      <div className="ml-8 mt-8 flex" key={type}>
        <span className={clsx("w-2/12", darkMode ? "" : "text-grayModern-600")}>
          {t(`SpecItem.${type}`)}
        </span>
        <Slider
          id="slider"
          className="mr-12"
          value={idx}
          min={0}
          max={specs.length - 1}
          colorScheme="primary"
          onChange={handleChange}
        >
          {specs.map((spec: any, i: number) => (
            <SliderMark
              key={spec.value}
              value={i}
              className={clsx("mt-2 whitespace-nowrap", darkMode ? "" : "text-grayModern-600")}
              ml={"-3"}
            >
              {spec.label}
            </SliderMark>
          ))}

          <SliderTrack>
            <SliderFilledTrack bg={"primary.200"} />
          </SliderTrack>
          {idx >= 0 ? (
            <SliderThumb bg={"primary.500"} />
          ) : (
            <SliderThumb
              onClick={() => {
                handleChange(0);
              }}
              style={{ opacity: 0 }}
            />
          )}
        </Slider>
      </div>
    );
  };

  return (
    <div className="w-full flex-1 rounded-md border">
      <div
        className={clsx(
          "flex items-center justify-between px-8 py-3.5",
          darkMode ? "" : "bg-[#F6F8F9]",
        )}
      >
        <div className="flex items-center">
          <TextIcon boxSize={4} mr={2} color={darkMode ? "" : "grayModern.600"} />
          <span className="text-lg font-semibold">{t("application.DatabaseSpecification")}</span>
        </div>
      </div>
      <div className="pb-8">
        <p className={clsx("text-sm mx-8 mt-4", darkMode ? "" : "text-grayModern-600")}>
          {t("application.DatabaseCreateTip")}
        </p>
        {buildSlider({
          type: "cpu",
          value: _.get(bundle, "dedicatedDatabase.cpu") as unknown as number,
          specs: find(resourceOptions, { type: "dedicatedDatabaseCPU" })?.specs || [],
          onChange: (value) => {
            onBundleItemChange(`dedicatedDatabase.cpu`, value);
          },
        })}
        {buildSlider({
          type: "memory",
          value: _.get(bundle, "dedicatedDatabase.memory") as unknown as number,
          specs: find(resourceOptions, { type: "dedicatedDatabaseMemory" })?.specs || [],
          onChange: (value) => {
            onBundleItemChange(`dedicatedDatabase.memory`, value);
          },
        })}
        {buildSlider({
          type: "capacity",
          min: originCapacity,
          value: _.get(bundle, "dedicatedDatabase.capacity") as unknown as number,
          specs: find(resourceOptions, { type: "dedicatedDatabaseCapacity" })?.specs || [],
          onChange: (value) => {
            onBundleItemChange(`dedicatedDatabase.capacity`, value);
          },
        })}
        {buildSlider({
          type: "replicas",
          min: originReplicas,
          value: _.get(bundle, "dedicatedDatabase.replicas") as unknown as number,
          specs: find(resourceOptions, { type: "dedicatedDatabaseReplicas" })?.specs || [],
          onChange: (value) => {
            onBundleItemChange(`dedicatedDatabase.replicas`, value);
          },
        })}
      </div>
    </div>
  );
}
