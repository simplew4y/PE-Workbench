"""从结构化框架提取估值日及字段，完整列出估值日至查询日的季度。"""

import calendar
import re
from datetime import date


# 将本地模型中的比率或敏感变量转成供应商可查询的基础字段。
FIELD_ALIASES = {
    "出货量": ["芯片出货量"],
    "产品综合ASP": ["产品解决方案收入", "芯片出货量", "平均销售单价（ASP）"],
    "授权服务收入": ["授权及服务收入"],
    "产品毛利率": ["产品解决方案毛利率"],
    "授权毛利率": ["授权及服务毛利率"],
    "经常其他收益净额": ["其他收入及收益净额"],
    "经营现金税率": ["所得税费用", "税前利润", "支付所得税"],
    "纯折旧摊销率": ["固定资产折旧", "无形资产摊销"],
    "租赁净现金调整率": ["使用权资产折旧", "租赁现金支出"],
    "资本开支率": ["资本开支"],
    "经营资金占增量收入": ["应收账款", "存货", "应付账款", "营运资金变动"],
    "WACC": ["无风险利率", "Beta", "股权风险溢价", "债务成本"],
    "永续增长": ["长期收入增长一致预期"],
    "投资回收率": ["联营公司投资账面值", "以公允价值计量的金融资产账面值"],
    "RMB每HKD": ["港元兑人民币汇率"],
    "应收/半年收入": ["应收账款", "营业收入"],
}


def quarter_periods(valuation_date, as_of):
    if valuation_date > as_of:
        raise ValueError("估值基准日晚于查询截止日。")
    year, quarter = valuation_date.year, (valuation_date.month - 1) // 3 + 1
    periods = []
    while (year, quarter) <= (as_of.year, (as_of.month - 1) // 3 + 1):
        start = date(year, quarter * 3 - 2, 1)
        month = quarter * 3
        end = date(year, month, calendar.monthrange(year, month)[1])
        label = f"{year}年第{'一二三四'[quarter - 1]}季度"
        suffix = "，季度未结束" if end > as_of else ""
        # 完整包含估值日所在季度；当前季度仅查询截至 as_of 的部分。
        periods.append(f"{label}（{start.isoformat()}至{min(end, as_of).isoformat()}{suffix}）")
        year, quarter = (year + 1, 1) if quarter == 4 else (year, quarter + 1)
    return periods


def build_framework_requests(framework, as_of):
    context = framework["context"]
    company = context["company"].strip()
    if not company:
        raise ValueError("框架未记载公司名称。")
    date_match = re.match(r"^(\d{4}-\d{2}-\d{2})(?:$|[，,；;\s])", context.get("valuation_date", ""))
    if date_match is None:
        raise ValueError("框架未记载明确的 valuation_date，不能以文件名或保存时间代替。")
    valuation_date = date.fromisoformat(date_match.group(1))
    periods = quarter_periods(valuation_date, as_of)
    ticker = context.get("ticker", "").strip()
    if not ticker:
        codes = {
            match.group(0)
            for source in framework.get("sources", [])
            for match in re.finditer(r"(?<![A-Z0-9])\d{4,5}\.HK(?![A-Z0-9])", source.get("locator", ""))
        }
        if len(codes) != 1:
            raise ValueError("框架未记载唯一证券代码，请在 context.ticker 中明确填写。")
        ticker = codes.pop()

    fields = ["营业收入", "毛利率", "营业利润", "归母净利润", "经营活动现金流量净额", "现金及现金等价物", "总股本"]
    names = [item["statement"] for item in framework.get("assumptions", [])]
    names += [item["metric"] for item in framework.get("monitoring", [])]
    for item in framework.get("sensitivities", []):
        perturbation = item.get("perturbation", {})
        name = perturbation.get("input") or perturbation.get("name")
        if name:
            names.append(name)
    for name in names:
        metric = re.split(r"[，,]", name, maxsplit=1)[0].strip()
        fields.extend(FIELD_ALIASES.get(metric, [metric]))
    fields = list(dict.fromkeys(fields))

    header = (
        f"公司全名：{company}\n证券代码：{ticker}\n"
        f"估值基准日：{valuation_date.isoformat()}\n数据截至：{as_of.isoformat()}\n"
        f"查询期间：{'；'.join(periods)}\n"
    )
    requests = []
    for start in range(0, len(fields), 8):
        batch_fields = fields[start:start + 8]
        query = (
            header
            + f"查询字段：{'、'.join(batch_fields)}\n"
            + "返回字段：公司名称、证券代码、指标名称、数值、报告期起止日、发布日期、单季或累计、单位、币种、"
            "实际或预测、数据来源、原始链接。半年累计、九个月累计、全年累计分别标明，不当作单季值；"
            "单季未独立披露或当前季度未披露的字段返回空，不推算。仅返回截至数据截止日已发布的数据。"
        )
        if len(query.encode("utf-16-le")) // 2 > 2000:
            raise ValueError("季度清单及查询字段超过 Wind 2000 字符上限，请缩小日期范围。")
        category = "analytics" if any(field in batch_fields for field in (
            "无风险利率", "Beta", "股权风险溢价", "债务成本", "港元兑人民币汇率",
        )) else "financials"
        requests.append({"category": category, "query": query})
    return requests
