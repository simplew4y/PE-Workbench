export const PE_INSUFFICIENT_BALANCE_MESSAGE =
  "平台余额不足，暂时无法使用平台模型。请联系管理员充值，或在个人中心 → 模型中切换到自定义模型。";

export function isPeInsufficientBalanceError(value: unknown): boolean {
  const text = value instanceof Error ? value.message : String(value ?? "");
  const normalized = text.toLowerCase();
  return normalized.includes("insufficient_balance")
    || normalized.includes("insufficient balance")
    || normalized.includes("平台余额不足");
}

export function humanizePeModelError(value: unknown): string {
  if (isPeInsufficientBalanceError(value)) return PE_INSUFFICIENT_BALANCE_MESSAGE;
  return value instanceof Error ? value.message : String(value ?? "");
}
