"use client";

import { useEffect, useRef, useState } from "react";
import { BookOpen, FileText } from "lucide-react";
import { ArtifactVersions, FrameworkConfirmation, ResearchRail, type ConfirmationStatus } from "../../components/research-ui/ResearchUI";
import styles from "./preview.module.css";

function Framework({ historical = false }: { historical?: boolean }) {
  return <article className={styles.document}><small>投资框架 · 演示资料</small>
    <h2>从品牌韧性到现金回报</h2><p>判断一家消费品牌能否将稳定需求，持续转化为可验证的盈利与现金流。</p>
    <section><small>01 / 需求</small><h3>增长是否来自真实的复购？</h3><p>区分提价、渠道扩张和终端销量，观察老客户留存与折扣变化。</p><p className={styles.note}>验证：同店销售、复购率、渠道库存。<br />失效信号：增长主要依赖促销和压货。</p></section>
    <section><small>02 / 盈利</small><h3>定价权能否穿越成本波动？</h3><p>结合毛利率与费用率，识别增长背后的真实经营效率。</p></section>
    {!historical && <section><small>03 / 现金</small><h3>利润是否转化为自由现金流？</h3><p>核对经营现金流、资本支出与营运资金，避免只看账面利润。</p></section>}
    <p className={styles.note}>以上为待验证的研究假设，不包含真实企业数据。</p>
  </article>;
}

export default function ResearchPreview() {
  const [status, setStatus] = useState<ConfirmationStatus>("draft");
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState("v2");
  const [failNext, setFailNext] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  function confirm() {
    if (timer.current) return;
    setStatus("pending");
    timer.current = setTimeout(() => {
      timer.current = null;
      if (failNext) { setStatus("error"); setFailNext(false); }
      else { setStatus("confirmed"); setSelected("framework"); }
    }, 900);
  }
  return <main className={styles.demo}>
    <header className={styles.top}><div><strong>研究交互实验室</strong><span>独立组件预览 · 本地模拟数据</span></div>
      <details><summary>演示控制</summary><div className={styles.controls}>
        <label>确认状态<select aria-label="确认状态" value={status} disabled={status === "pending"} onChange={(event) => setStatus(event.target.value as ConfirmationStatus)}>
          <option value="draft">待确认</option><option value="pending" disabled>确认中</option><option value="confirmed">已确认</option><option value="error">失败重试</option><option value="stale">旧草稿</option>
        </select></label>
        <label><input type="checkbox" checked={failNext} disabled={status === "pending"} onChange={(event) => setFailNext(event.target.checked)} />模拟下一次确认失败</label>
        <button type="button" disabled={status === "pending"} onClick={() => { setStatus("draft"); setSelected(null); setVersion("v2"); setFailNext(false); }}>重置演示</button>
      </div></details></header>
    <div className={styles.workspace}>
      <div className={styles.chat}><div className={styles.conversation}>
        <p className={styles.eyebrow}>消费研究 / 新的判断</p>
        <div className={styles.user}>帮我建立一个消费品牌的投资框架，重点看需求韧性和现金流。</div>
        <article className={styles.reply}><small>RESEARCH AGENT</small><h1>先明确，我们要验证什么。</h1>
          <p>我将框架收敛为三个问题：需求是否真实、盈利是否稳健，以及利润能否兑现为现金。</p>
          <ol><li><strong>需求韧性</strong> — 拆开销量、价格与渠道贡献。</li><li><strong>盈利质量</strong> — 检查定价权与费用效率。</li><li><strong>现金回报</strong> — 用现金流验证利润。</li></ol>
          <p>这是一份待确认草稿。确定后，它会成为右侧的研究基准；之后的调整仍可以直接在这里讨论。</p>
          <FrameworkConfirmation status={status} onConfirm={confirm} preview={<Framework />} />
        </article>
        {status === "confirmed" && <div className={styles.receipt} role="status">演示：框架已确认。正式接入后，Agent 将在这段对话中继续研究。</div>}
      </div><div className={styles.composer}>继续讨论投资逻辑…<small>交互预览，不发送消息</small></div></div>
      <ResearchRail selectedId={selected} onSelect={setSelected} artifacts={[
        { id: "framework", label: "投资框架", icon: <BookOpen size={19} />, subtitle: status === "confirmed" ? "正式版本 · v2" : "等待你的确认",
          actions: status === "confirmed" ? <ArtifactVersions versions={[{ id: "v1", label: "v1 · 历史演示版本" }, { id: "v2", label: "v2 · 当前版本" }]} selectedId={version} onSelect={setVersion} /> : undefined,
          content: status === "confirmed" ? <Framework historical={version === "v1"} /> : <div className={styles.empty}><BookOpen size={28} /><h2>让判断在对话中成形</h2><p>确认回复下方的框架后，正式内容会保存在这里。</p></div> },
        { id: "memo", label: "Memo", icon: <FileText size={19} />, subtitle: "演示文稿 · v1", content: <article className={styles.document}><small>RESEARCH MEMO</small><h2>品牌增长的质量</h2><p>当前最值得追问的，是增长来源与现金兑现之间的关系。</p><section><h3>下一步证据</h3><p>补充终端销量、渠道库存和经营现金流，再判断增长是否具备持续性。</p></section><p className={styles.note}>此文稿为静态样例，不来自业务数据库。</p></article> },
      ]} />
    </div>
  </main>;
}
