#!/usr/bin/env python3
"""Identify and cluster a global PE upload without changing the ingest pipeline."""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote_plus

PIPELINE_DIR = Path(__file__).resolve().parent / "pipeline"
sys.path.insert(0, str(PIPELINE_DIR))

from document_classifier import build_document_preview, classify_document  # noqa: E402


def normalized_identity(value: str) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).casefold()
    text = re.sub(r"[^\w\u3400-\u9fff]+", "", text, flags=re.UNICODE)
    for suffix in (
        "股份有限公司", "有限责任公司", "有限公司", "corporation", "incorporated",
        "holdings", "limited", "corp", "inc", "ltd",
    ):
        normalized_suffix = re.sub(r"\W+", "", suffix.casefold())
        if text.endswith(normalized_suffix) and len(text) > len(normalized_suffix):
            return text[: -len(normalized_suffix)]
    return text


def normalized_ticker(value: str) -> str:
    text = re.sub(r"[^A-Za-z0-9]+", "", str(value or "")).upper()
    for suffix in ("SZ", "SH", "BJ", "HK", "OQ", "US", "CH", "PA", "DE", "L", "N"):
        if text.endswith(suffix) and len(text) > len(suffix) + 1:
            return text[: -len(suffix)]
    return text


def identities_match(left: str, right: str) -> bool:
    left_key = normalized_identity(left)
    right_key = normalized_identity(right)
    if not left_key or not right_key:
        return False
    if left_key == right_key:
        return True
    return min(len(left_key), len(right_key)) >= 4 and (
        left_key in right_key or right_key in left_key
    )


@dataclass(frozen=True)
class Identity:
    company_name: str = ""
    company_ticker: str = ""
    company_confidence: float = 0.0
    ticker_confidence: float = 0.0
    method: str = "not_detected"


def clean_filename_company_name(value: str) -> str:
    text = unquote_plus(unicodedata.normalize("NFKC", value or ""))
    return re.sub(r"[_\s]+", " ", text).strip(" ._-")


def filename_identity(filename: str) -> Identity:
    stem = unicodedata.normalize("NFKC", Path(filename).stem)
    stem = re.sub(r"^\d{10,}[_\s-]+", "", stem)
    structured = re.match(
        r"^(?P<company>.+?)_(?P<symbol>[A-Za-z0-9]{1,12})"
        r"(?:_[A-Za-z])?\.(?P<market>[A-Za-z]{1,5})(?:_|$)",
        stem,
    )
    if structured:
        return Identity(
            company_name=clean_filename_company_name(structured.group("company")),
            company_ticker=f"{structured.group('symbol').upper()}.{structured.group('market').upper()}",
            company_confidence=0.995,
            ticker_confidence=0.995,
            method="structured_filename",
        )
    compact_chinese = re.match(
        r"^(?P<company>[\u3400-\u9fff·（）()]{2,30}?)(?P<symbol>\d{6})(?=\D|$)", stem
    )
    if compact_chinese:
        return Identity(
            company_name=compact_chinese.group("company"),
            company_ticker=compact_chinese.group("symbol"),
            company_confidence=0.99,
            ticker_confidence=0.99,
            method="filename_company_ticker",
        )
    chinese_company = re.match(
        r"^(?P<company>[\u3400-\u9fff·（）()]{2,30}?)(?="
        r"(?:20\d{2}|年度|近况|交流|调研|研究|报告|纪要|[-_]))",
        stem,
    )
    ticker_match = re.search(
        r"(?<!\d)(?P<symbol>\d{6})(?:[ ._-]*(?P<market>CH|HK|SZ|SH|BJ))?(?!\d)",
        stem,
        flags=re.IGNORECASE,
    )
    company_name = chinese_company.group("company") if chinese_company else ""
    company_ticker = ""
    if ticker_match:
        company_ticker = ticker_match.group("symbol")
        if ticker_match.group("market"):
            company_ticker += f".{ticker_match.group('market').upper()}"
    if company_name or company_ticker:
        return Identity(
            company_name=company_name,
            company_ticker=company_ticker,
            company_confidence=0.97 if company_name else 0.0,
            ticker_confidence=0.97 if company_ticker else 0.0,
            method=(
                "filename_company_ticker" if company_name and company_ticker
                else "filename_company" if company_name else "filename_ticker"
            ),
        )
    return Identity()


def combined_identity(classification: Any, filename: str) -> Identity:
    from_filename = filename_identity(filename)
    classified_name = str(getattr(classification, "company_name", "") or "").strip()
    classified_ticker = str(getattr(classification, "company_ticker", "") or "").strip()
    classified_confidence = float(getattr(classification, "company_confidence", 0) or 0)
    agree = bool(
        from_filename.company_name and classified_name
        and identities_match(from_filename.company_name, classified_name)
    )
    company_name = classified_name if agree else from_filename.company_name or classified_name
    company_confidence = (
        max(from_filename.company_confidence, classified_confidence) if agree
        else from_filename.company_confidence if from_filename.company_name
        else classified_confidence
    )
    methods = [
        value for value in (
            from_filename.method if from_filename.method != "not_detected" else "",
            str(getattr(classification, "company_method", "") or ""),
        ) if value
    ]
    return Identity(
        company_name=company_name,
        company_ticker=from_filename.company_ticker or classified_ticker,
        company_confidence=company_confidence,
        ticker_confidence=(
            from_filename.ticker_confidence if from_filename.company_ticker
            else classified_confidence if classified_ticker else 0.0
        ),
        method="+".join(dict.fromkeys(methods)) or "not_detected",
    )


def cluster(items: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    parents = list(range(len(items)))

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    def union(left: int, right: int) -> None:
        left_root, right_root = find(left), find(right)
        if left_root != right_root:
            parents[right_root] = left_root

    for left_index, left_item in enumerate(items):
        left = Identity(**left_item["identity"])
        for right_index in range(left_index + 1, len(items)):
            right = Identity(**items[right_index]["identity"])
            same_ticker = bool(
                left.company_ticker and right.company_ticker
                and normalized_ticker(left.company_ticker) == normalized_ticker(right.company_ticker)
            )
            same_company = bool(
                left.company_name and right.company_name
                and identities_match(left.company_name, right.company_name)
            )
            if same_ticker or same_company:
                union(left_index, right_index)
    groups: dict[int, list[dict[str, Any]]] = {}
    for index, item in enumerate(items):
        groups.setdefault(find(index), []).append(item)
    return list(groups.values())


def merge(group: list[dict[str, Any]]) -> Identity:
    identities = [Identity(**item["identity"]) for item in group]
    names = sorted(
        (identity for identity in identities if identity.company_name),
        key=lambda identity: (-identity.company_confidence, -len(identity.company_name)),
    )
    tickers = sorted(
        (identity for identity in identities if identity.company_ticker),
        key=lambda identity: (
            -identity.ticker_confidence, -int("." in identity.company_ticker),
            -len(identity.company_ticker),
        ),
    )
    methods = [identity.method for identity in identities if identity.method != "not_detected"]
    return Identity(
        company_name=names[0].company_name if names else "",
        company_ticker=tickers[0].company_ticker if tickers else "",
        company_confidence=names[0].company_confidence if names else 0.0,
        ticker_confidence=tickers[0].ticker_confidence if tickers else 0.0,
        method="+".join(dict.fromkeys(methods)) or "not_detected",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest")
    args = parser.parse_args()
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    identified: list[dict[str, Any]] = []
    failed: list[dict[str, str]] = []
    for item in manifest.get("items", []):
        try:
            preview = build_document_preview(Path(item["stagedPath"]))
            classification = classify_document(preview, expected_company="", expected_ticker="")
            identity = combined_identity(classification, item["originalFilename"])
            identified.append({**item, "identity": asdict(identity)})
        except Exception as exc:  # noqa: BLE001
            failed.append({**item, "error": str(exc)})
    payload = {
        "groups": [
            {"identity": asdict(merge(group)), "items": group}
            for group in cluster(identified)
        ],
        "failed": failed,
    }
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
