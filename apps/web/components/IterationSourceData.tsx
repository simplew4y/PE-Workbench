"use client";

import { useState } from "react";
import type { IterationObservations, IterationSourceData as SourceData } from "@earendil-works/pe-boot";
import { sourceDataObservations } from "@/lib/iteration-source-data";
import { PeSourceCitation } from "./PeSourceCitation";
import styles from "./FrameworkIterationTest.module.css";

export function IterationSourceData({ rows, observations, cwd }: { rows: SourceData[]; observations?: IterationObservations; cwd: string }) {
  const [filter, setFilter] = useState("all");
  const annotated = rows.map(row => ({ row, used: sourceDataObservations(row, observations) }));
  const usedCount = annotated.filter(item => item.used.length).length;
  const shown = annotated.filter(item => filter === "all" || (filter === "used" ? item.used.length > 0 : item.used.length === 0));
  return <section className={styles.panel} aria-label="采集数据">
    <div className={styles.sectionHeading}><h2>采集数据</h2><span className={styles.count}>Wind · {rows.length} 个字段值</span></div>
    <p>以下是 Wind 返回并保存的全部可识别财务字段，不经过 LLM 改写；期间、单位和币种沿用原始返回。</p>
    <div className={styles.reviewToolbar}><p>{observations ? `已进入 Agent 提取结果 ${usedCount} 项 · 未进入 ${rows.length - usedCount} 项` : "Agent 尚未完成提取，使用状态待确定。"}</p><label>使用状态<select aria-label="采集数据使用状态" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部数据</option><option value="used">已进入提取结果</option><option value="unused">未进入提取结果</option></select></label></div>
    <p className={styles.caption}>金额字段已明确币种 {rows.filter(row => typeof row.value === "number" && !/%|百分/.test(row.unit ?? "") && row.currency).length} 项；已明确期间类型 {rows.filter(row => row.periodKind !== "unknown").length} 项；已明确财务/业务口径 {rows.filter(row => row.scope).length} 项；已明确实际/预测角色 {rows.filter(row => row.role).length} 项。未知字段保留为空，不根据查询要求填充。</p>
    <p className={styles.caption}>“已使用”仅表示进入有效提取结果，不代表已核实、已采用或已发布；“未进入”不代表 Agent 没有读过或数据没有价值。采集时间不等于披露时间。</p>
    {!rows.length ? <p>尚未取得可展示的财务字段；查询失败、空结果与无法识别的结构请查看上方采集回执。</p> : <div className={`${styles.table} ${styles.sourceDataTable}`}><table><caption className={styles.caption}>Wind 采集字段与 Agent 使用状态</caption><thead><tr><th>指标 / 主体</th><th>原始数值</th><th>期间 / 口径</th><th>单位 / 币种</th><th>Agent 使用</th><th>来源</th></tr></thead><tbody>{shown.map(({ row, used }) => <tr key={`${row.queryId}:${row.line}`}><td>{row.metric}<small>{row.companyTicker} · {row.scope || "业务口径未明确"}</small>{row.definition && <small>供应商定义：{row.definition}</small>}</td><td>{row.value ?? "未返回值"}</td><td>{row.period || "期间未明确"}<small>{{ single: "单期", cumulative: "累计", unknown: "单期或累计未明确" }[row.periodKind]} · {row.role === "fact" ? "实际" : row.role === "forecast" ? "预测" : "实际或预测未明确"}</small></td><td>{row.unit || "单位未明确"}<small>{row.currency || "币种未明确"}</small></td><td><span data-used={used.length > 0}>{!observations ? "待提取" : used.length ? "已进入提取结果" : "未进入提取结果"}</span>{used.map(item => <small key={item.id}>{item.metric} · {item.id}</small>)}</td><td>Wind <PeSourceCitation cwd={cwd} evidenceId={row.evidenceId}>Wind 原始字段</PeSourceCitation><small>{row.fetchedAt ? new Date(row.fetchedAt).toLocaleString() : "采集时间未记录"}</small><details><summary>原始响应位置</summary>{[...new Set(row.paths)].map(path => <code key={path}>{path}</code>)}</details></td></tr>)}</tbody></table>{!shown.length && <p>当前筛选没有匹配数据。</p>}</div>}
  </section>;
}
