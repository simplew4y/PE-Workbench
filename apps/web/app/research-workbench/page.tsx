import type { Metadata } from "next";
import { FrameworkIterationTest } from "@/components/FrameworkIterationTest";

export const metadata: Metadata = { title: "研究工作台 · PE Workbench" };

export default function Page() {
  return <FrameworkIterationTest workspace />;
}
