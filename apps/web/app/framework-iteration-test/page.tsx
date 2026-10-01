import { Suspense } from "react";
import { PeAccountGate } from "@/components/PeAccountGate";
import { I18nProvider } from "@/hooks/useI18n";
import { FrameworkIterationTest } from "@/components/FrameworkIterationTest";

export default function Page() {
  return <Suspense><PeAccountGate><I18nProvider><FrameworkIterationTest /></I18nProvider></PeAccountGate></Suspense>;
}
