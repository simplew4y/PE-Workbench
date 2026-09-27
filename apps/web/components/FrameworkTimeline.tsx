"use client";

import { useId, useState } from "react";
import type { FrameworkVersion } from "@earendil-works/pe-boot";
import { frameworkVersionDiff } from "@/lib/framework-report";
import styles from "./PeFrameworkPanel.module.css";

export function FrameworkTimeline({ versions, selectedId, currentId, onSelect }: {
  versions: FrameworkVersion[]; selectedId: string; currentId: string | null; onSelect: (id: string) => void;
}) {
  const [comparison, setComparison] = useState<string | null>(null);
  const panelId = useId();
  const ordered = [...versions].sort((a, b) => a.version - b.version);
  const index = ordered.findIndex((version) => version.id === comparison);
  const before = ordered[index - 1];
  const after = ordered[index];
  const changes = before && after ? frameworkVersionDiff(before.content, after.content) : [];
  return <div className={styles.timelineModule}>
    <div className={styles.timelineCaption}><strong>框架演进</strong><span>{ordered.length} 个版本</span></div>
    <nav className={styles.timeline} aria-label="投资框架版本时间线">
      {ordered.map((version, i) => <div className={styles.timelineStep} key={version.id}>
        {i > 0 && <div className={styles.timelineBridge}><button type="button" aria-expanded={comparison === version.id} aria-controls={panelId}
          aria-label={`查看 v${ordered[i - 1].version} 到 v${version.version} 的差异`}
          onClick={() => setComparison(comparison === version.id ? null : version.id)}>变化</button></div>}
        <button type="button" className={styles.timelineNode} aria-current={selectedId === version.id ? "step" : undefined}
          onClick={() => { onSelect(version.id); setComparison(null); }}>
          <span className={styles.timelineDot} aria-hidden="true" />
          <strong>v{version.version}{currentId === version.id && <em>最新</em>}</strong>
          <time dateTime={version.createdAt}>{new Date(version.createdAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}</time>
        </button>
      </div>)}
    </nav>
    <div id={panelId}>
      {before && after && <section className={styles.versionComparison} aria-label={`v${before.version} 到 v${after.version} 版本差异`}>
        <div className={styles.comparisonHeading}><div><strong>v{before.version} → v{after.version}</strong><p>{changes.length ? `${changes.length} 项变化` : "报告内容没有变化"}</p></div>
          <button type="button" onClick={() => setComparison(null)}>收起差异</button></div>
        {(["新增", "修改", "移除"] as const).map((kind) => {
          const group = changes.filter((change) => change.kind === kind);
          return group.length > 0 && <div key={kind} className={styles.changeGroup}><h3>{kind} <span>{group.length}</span></h3>
            {group.map((change) => <details key={change.id} className={styles.changeEntry}>
              <summary>{change.title}<span>{change.fields.length} 处变化</span></summary>
              {change.fields.map((field) => <div className={styles.changeField} key={field.label}><h4>{field.label}</h4><div className={styles.diffColumns}>
                <div><small>v{before.version}</small><p>{field.before || "—"}</p></div>
                <div><small>v{after.version}</small><p>{field.after || "—"}</p></div>
              </div></div>)}
            </details>)}
          </div>;
        })}
      </section>}
    </div>
  </div>;
}
