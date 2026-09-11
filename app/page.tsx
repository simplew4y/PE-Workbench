import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { I18nProvider } from "@/hooks/useI18n";
import { PeAccountGate } from "@/components/PeAccountGate";

export default function Home() {
  return (
    <Suspense>
      <PeAccountGate>
        <I18nProvider>
          <AppShell />
        </I18nProvider>
      </PeAccountGate>
    </Suspense>
  );
}
