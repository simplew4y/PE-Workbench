import type { Metadata } from "next";
import { ResearchWorkbench } from "../research-workbench";

export const metadata: Metadata = { title: "研究工作台演示 · PE Workbench" };

export default function Page() {
  return <ResearchWorkbench />;
}
