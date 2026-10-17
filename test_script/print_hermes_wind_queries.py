"""根据爱马仕当前框架调用 Wind，仅打印返回的数据文本。

运行：python3 test_script/print_hermes_wind_queries.py
地平线：python3 test_script/print_hermes_wind_queries.py --framework outputs/horizon-2026-10-13/framework-state.json
需要 Node.js >=22.19，凭据沿用现有 WIND_API_KEY 或 ~/.wind-aifinmarket/config。
"""

import argparse
import json
import re
import sqlite3
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from framework_wind_queries import build_framework_requests
from print_hermes_framework import load_framework


# 当前爱马仕框架的条目到外部数据字段的人工映射，不向 Wind 发送研究正文。
FIELD_REQUESTS = {
    "valuation_anchor": (
        "最新交易日；2026、2027财年预测",
        "收盘价、交易日期、预测EPS、预测市盈率、券商目标价、目标价对应年度、目标价对应EPS及市盈率",
    ),
    "dcf_cross_check": (
        "2024、2025年报；2026年最新已披露报告及上年同期；2026—2031财年预测",
        "营业收入、EBIT、自由现金流、资本开支、营运资本变动、现金及等价物、有息负债、总股本、预测现金流",
    ),
    "terminal_value_dependence": (
        "最新可得估计；2029—2031财年预测",
        "无风险利率、Beta、股权风险溢价、债务成本、WACC及其估计日期和方法、预测自由现金流、预测资本开支、预测营运资本",
    ),
    "margin_expansion": (
        "2024、2025年报；2026年最新已披露报告及上年同期；2026—2031财年预测",
        "营业收入、毛利率、经常性营业利润、EBIT、EBITA、各口径利润率、销售及管理费用、员工成本、汇率影响、管理层利润率指引",
    ),
    "growth_driver": (
        "2025年；2026年已披露季度；2027年指引",
        "销量、售价变动幅度、皮具收入及占比、量价拆分、工坊投产数量及日期、工匠人数、产能、管理层提价指引",
    ),
    "sales_growth_path": (
        "2025年及各季度；2026年已披露季度和累计期间；2026—2031财年预测",
        "营业收入、同比增速、固定汇率增速、当前汇率增速、汇率影响金额、有机增速、收入一致预期",
    ),
    "multiple_sustainability": (
        "2025年至今；2026—2028财年预测",
        "股价、市盈率历史序列、预测EPS、预测市盈率、EPS一致预期修正、可比公司名称及代码、可比公司同年度预测市盈率",
    ),
    "fixed_cost_leverage": (
        "2024、2025年报；2026年最新已披露报告及上年同期",
        "营业收入、营业利润率、人员成本、租金、制造费用、员工人数、工坊数量、产能利用率、单店产出、单工坊产出",
    ),
    "price_basis_conflict": (
        "最新交易日",
        "收盘价、报价时间、总市值、总股本、市值币种、价格币种、交易所、ISIN、股份类别",
    ),
    # 模型估值日期只能从本地模型核验，不向 Wind 请求。
    "valuation_date_gap": None,
    "subject_mapping": (
        "当前有效证券资料",
        "发行人全名、Wind证券代码、ISIN、交易所、上市地、交易币种、股份类别、各证券标识的对应关系",
    ),
    "sector_growth_premium": (
        "2025年；2026年已披露季度及上年同期；2027—2030财年预测",
        "Hermès、LVMH、Richemont、Kering的季度有机收入增速、年度提价幅度、ROIC、行业收入增速、行业样本及统计方法",
    ),
    "street_target_cluster": (
        "最新预测及前次预测",
        "券商名称、研报发布日期、评级、目标价、前次目标价、目标价对应年度、预测EPS、估值倍数、覆盖券商数、一致预期目标价",
    ),
    "h1_2026_actuals_check": (
        "2026年上半年、最新已披露季度及累计期间、各期间上年同期",
        "营业收入、固定汇率增速、当前汇率增速、汇率影响、经常性营业利润、营业利润、EBIT、EBITA、税前利润、净利润、总资产、总负债、股东权益",
    ),
    "ownership_structure": (
        "2026年第二季度末及最新披露期",
        "主要股东名称、持股数量、持股比例、总股本、库存股数量、投票权比例、股权变动日期",
    ),
    "retail_brand_events": (
        "2026年已披露信息",
        "门店名称、地区、开业日期、门店面积、门店数量、新开门店数、关闭门店数、翻新门店数、产品名称及售价、产品发布日期",
    ),
    "china_demand_deterioration": (
        "2026年6月、7月及其后已披露月份；对应上年同期及前月；2026年已披露季度及上年同期",
        "Hermès中国区销售额、同比增速、环比增速、销售统计口径（零售流水或公司收入）、分地区季度收入及同比增速、"
        "中国奢侈品市场销售额及同比和环比增速、25家品牌样本名单、样本销售额、统计覆盖范围、彭博原始统计日期及链接",
    ),
}

WIND_CATEGORIES = {
    "valuation_anchor": "analytics",
    "terminal_value_dependence": "analytics",
    "multiple_sustainability": "analytics",
    "price_basis_conflict": "analytics",
    "subject_mapping": "analytics",
    "sector_growth_premium": "analytics",
    "street_target_cluster": "analytics",
    "ownership_structure": "holders",
    "retail_brand_events": "news",
    "china_demand_deterioration": "news",
}


def build_queries(report, as_of):
    identity = re.match(r"^(.+?)（([^）]+)）", report["title"])
    if identity is None:
        raise ValueError("当前框架标题未包含可提取的公司全名和股票代码。")
    security_ids = re.sub(r"\s+映射未完成$", "", identity.group(2))
    header = (
        f"公司全名：{identity.group(1)}\n"
        f"待核对证券标识：{security_ids}\n"
        f"数据截至：{as_of}\n"
    )
    queries = []
    for item in report["items"]:
        if item["id"] not in FIELD_REQUESTS:
            raise ValueError(f"条目 {item['id']} 尚未配置查询字段。")
        request = FIELD_REQUESTS[item["id"]]
        if request is None:
            continue
        periods, fields = request
        query = (
            header
            + f"查询期间：{periods}\n"
            + f"查询字段：{fields}\n"
            + "返回字段：发行人名称、证券代码、ISIN、交易所、股份类别、指标名称、数值、报告期、发布日期、"
            "单期或累计、单位、币种、报表口径、实际或预测、数据来源、原始链接。缺失字段返回空。"
        )
        # Wind queryWind 的 query 上限按 JavaScript UTF-16 长度计数。
        if len(query.encode("utf-16-le")) // 2 > 2000:
            raise ValueError(f"条目 {item['id']} 的查询超过 Wind 2000 字符上限。")
        queries.append(query)
    if not queries:
        raise ValueError("当前框架没有可追踪的条目。")
    return queries


def main():
    parser = argparse.ArgumentParser(description="读取投资框架，调用 Wind，仅输出返回的数据文本。")
    parser.add_argument("--framework", type=Path, help="结构化 framework-state.json；使用其中的估值日期逐季查询。")
    args = parser.parse_args()
    as_of = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    if args.framework:
        framework = json.loads(args.framework.read_text(encoding="utf-8"))
        requests = build_framework_requests(framework, as_of)
    else:
        _, _, report = load_framework()
        queries = build_queries(report, as_of.isoformat())
        categories = [
            WIND_CATEGORIES.get(item["id"], "financials")
            for item in report["items"]
            if FIELD_REQUESTS[item["id"]] is not None
        ]
        requests = [{"category": categories[index], "query": query} for index, query in enumerate(queries)]
    return subprocess.run(
        ["node", "--disable-warning=ExperimentalWarning", str(Path(__file__).with_name("query_wind.mjs"))],
        input=json.dumps(requests, ensure_ascii=False),
        text=True,
        check=False,
    ).returncode


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, sqlite3.Error, ValueError, KeyError, TypeError) as error:
        print(f"无法查询 Wind：{error}", file=sys.stderr)
        sys.exit(1)
