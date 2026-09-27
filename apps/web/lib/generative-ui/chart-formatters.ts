type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as UnknownRecord : {};
}

function displayText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

export function escapeHtml(value: unknown): string {
  return displayText(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

export function formatRiskTooltip(params: unknown): string {
  const data = asRecord(asRecord(params).data);
  const values = Array.isArray(data.value) ? data.value : [];
  const name = escapeHtml(data.name) || "风险项";
  const likelihood = displayText(values[0]) || "—";
  const impact = displayText(values[1]) || "—";
  const description = escapeHtml(data.description);
  return `<strong>${name}</strong><br/>发生可能性：${likelihood} / 5<br/>影响程度：${impact} / 5${description ? `<br/>${description}` : ""}`;
}

export function formatTreemapTooltip(params: unknown): string {
  const data = asRecord(asRecord(params).data);
  const name = escapeHtml(data.name) || "业务分部";
  const rawValue = typeof data.value === "number" && Number.isFinite(data.value) ? data.value.toLocaleString() : "—";
  const unit = escapeHtml(data.unit);
  const change = escapeHtml(data.change);
  return `${name}<br/><strong>${rawValue}${unit}</strong>${change ? `<br/>${change}` : ""}`;
}

export function formatTreemapLabel(params: unknown): string {
  const data = asRecord(asRecord(params).data);
  const name = displayText(data.name) || "业务分部";
  const rawValue = typeof data.value === "number" && Number.isFinite(data.value) ? data.value.toLocaleString() : "—";
  const unit = displayText(data.unit);
  const change = displayText(data.change);
  return `{name|${name}}\n{value|${rawValue}${unit}}${change ? `\n{change|${change}}` : ""}`;
}

export function chartDatumName(params: unknown): string | undefined {
  const name = asRecord(asRecord(params).data).name;
  return typeof name === "string" && name.trim() ? name : undefined;
}

export function formatPeerTooltip(params: unknown): string {
  const data = asRecord(asRecord(params).data);
  const values = Array.isArray(data.value) ? data.value : [];
  const name = escapeHtml(data.name) || "同业公司";
  const x = displayText(values[0]) || "—";
  const y = displayText(values[1]) || "—";
  const description = escapeHtml(data.description);
  return `<strong>${name}</strong><br/>X：${x}<br/>Y：${y}${description ? `<br/>${description}` : ""}`;
}
