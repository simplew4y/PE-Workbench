#!/usr/bin/env python3
"""Format adapters retained for chat session attachments.

The adapters in this module only extract source content and provenance.  They
return dictionaries consumed by the session attachment text extractor and do
not write to SQLite.

DOCX and PPTX are parsed as Office Open XML packages with the Python standard
library.  No optional Office dependency is required, and malformed packages
raise :class:`FormatAdapterError` instead of being treated as empty documents.
"""

from __future__ import annotations

import csv
import io
import posixpath
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence
from xml.etree import ElementTree as ET


SUPPORTED_EXTENSIONS = frozenset({".docx", ".pptx", ".csv", ".md", ".markdown", ".txt"})
DEFAULT_MAX_CHARS = 2200
MAX_XML_MEMBER_BYTES = 64 * 1024 * 1024


class FormatAdapterError(RuntimeError):
    """Raised when a supported source cannot be parsed safely."""


class UnsupportedFormatError(FormatAdapterError):
    """Raised when no adapter is registered for a source suffix."""


@dataclass(frozen=True)
class _PackedPiece:
    text: str
    start: int
    end: int
    part_index: int = 1
    part_count: int = 1


_W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
_P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
_R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"

_W = f"{{{_W_NS}}}"
_A = f"{{{_A_NS}}}"
_P = f"{{{_P_NS}}}"
_R = f"{{{_R_NS}}}"
_PKG_REL = f"{{{_PKG_REL_NS}}}"


def supports_path(path: str | Path) -> bool:
    """Return whether *path* has a suffix handled by this module."""

    return Path(path).suffix.lower() in SUPPORTED_EXTENSIONS


def adapt_document(path: str | Path, *, max_chars: int = DEFAULT_MAX_CHARS) -> list[dict[str, Any]]:
    """Extract a supported document into ``_write_chunks`` compatible rows.

    Args:
        path: Local source file.
        max_chars: Target maximum size for a content chunk.  Very long source
            lines or table rows are split without discarding content.

    Raises:
        FileNotFoundError: The path does not name a regular file.
        UnsupportedFormatError: The suffix has no adapter.
        FormatAdapterError: A supported source is corrupt or undecodable.
    """

    source = Path(path).expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(f"document path is not a file: {source}")
    _validate_max_chars(max_chars)
    suffix = source.suffix.lower()
    adapter = _ADAPTERS.get(suffix)
    if adapter is None:
        supported = ", ".join(sorted(SUPPORTED_EXTENSIONS))
        raise UnsupportedFormatError(f"Unsupported document type {suffix or '(none)'}; supported: {supported}")
    return adapter(source, max_chars=max_chars)


def adapt_text(path: str | Path, *, max_chars: int = DEFAULT_MAX_CHARS) -> list[dict[str, Any]]:
    """Extract a plain-text file with stable line-range provenance."""

    source = Path(path)
    _validate_max_chars(max_chars)
    text, encoding = _read_text(source)
    lines = text.splitlines()
    chunks = [
        _document_summary_chunk(
            source,
            content_type="text_document_summary",
            lines=(
                f"Text document: {source.name}\n"
                f"Encoding: {encoding}\n"
                f"Lines: {len(lines)}\n"
                f"Characters: {len(text)}"
            ),
            metadata={"encoding": encoding, "line_count": len(lines), "character_count": len(text)},
        )
    ]
    items = [(line_number, line) for line_number, line in enumerate(lines, start=1) if line.strip()]
    for piece_index, piece in enumerate(_pack_numbered_items(items, max_chars=max_chars), start=1):
        title_path = [source.stem, f"lines {piece.start}-{piece.end}"]
        chunks.append(
            _make_chunk(
                content=piece.text,
                content_type="text_lines",
                title_path=title_path,
                source_ref=f"{source.name} lines {piece.start}-{piece.end}",
                metadata={
                    "encoding": encoding,
                    "line_start": piece.start,
                    "line_end": piece.end,
                    "part_index": piece.part_index,
                    "part_count": piece.part_count,
                },
                locations=[
                    {
                        "display_text": f"{source.name} lines {piece.start}-{piece.end}",
                        "metadata": {
                            "line_start": piece.start,
                            "line_end": piece.end,
                            "part_index": piece.part_index,
                            "part_count": piece.part_count,
                        },
                    }
                ],
            )
        )
    return chunks


def adapt_markdown(path: str | Path, *, max_chars: int = DEFAULT_MAX_CHARS) -> list[dict[str, Any]]:
    """Extract Markdown sections while preserving heading and line ranges."""

    source = Path(path)
    _validate_max_chars(max_chars)
    text, encoding = _read_text(source)
    lines = text.splitlines()
    sections = _markdown_sections(lines, source.stem)
    chunks = [
        _document_summary_chunk(
            source,
            content_type="markdown_document_summary",
            lines=(
                f"Markdown document: {source.name}\n"
                f"Encoding: {encoding}\n"
                f"Lines: {len(lines)}\n"
                f"Sections: {len(sections)}"
            ),
            metadata={"encoding": encoding, "line_count": len(lines), "section_count": len(sections)},
        )
    ]
    for heading_path, items in sections:
        for piece in _pack_numbered_items(items, max_chars=max_chars):
            display = f"{source.name} lines {piece.start}-{piece.end}"
            metadata = {
                "encoding": encoding,
                "line_start": piece.start,
                "line_end": piece.end,
                "heading_path": heading_path,
                "part_index": piece.part_index,
                "part_count": piece.part_count,
            }
            chunks.append(
                _make_chunk(
                    content=piece.text,
                    content_type="markdown_section",
                    title_path=heading_path,
                    source_ref=display,
                    metadata=metadata,
                    locations=[{"display_text": display, "metadata": metadata}],
                )
            )
    return chunks


def adapt_csv(path: str | Path, *, max_chars: int = DEFAULT_MAX_CHARS) -> list[dict[str, Any]]:
    """Extract CSV rows with table, row-range, and cell-range provenance."""

    source = Path(path)
    _validate_max_chars(max_chars)
    text, encoding = _read_text(source)
    sample = text[:16384]
    dialect = _detect_csv_dialect(sample)
    try:
        rows = [list(row) for row in csv.reader(io.StringIO(text, newline=""), dialect)]
    except csv.Error as exc:
        raise FormatAdapterError(f"Unable to parse CSV {source}: {exc}") from exc

    max_columns = max((len(row) for row in rows), default=0)
    has_header = bool(rows) and _csv_has_header(sample)
    if has_header:
        headers = _pad_row(rows[0], max_columns)
        data_rows = [(row_index, _pad_row(row, max_columns)) for row_index, row in enumerate(rows[1:], start=2)]
        header_row = 1
    else:
        headers = [f"column_{index}" for index in range(1, max_columns + 1)]
        data_rows = [(row_index, _pad_row(row, max_columns)) for row_index, row in enumerate(rows, start=1)]
        header_row = None

    delimiter = getattr(dialect, "delimiter", ",")
    table_name = source.stem
    chunks = [
        _document_summary_chunk(
            source,
            content_type="csv_document_summary",
            lines=(
                f"CSV table: {source.name}\n"
                f"Table name: {table_name}\n"
                f"Encoding: {encoding}\n"
                f"Rows: {len(rows)}; columns: {max_columns}\n"
                f"Header detected: {'yes' if has_header else 'no'}; delimiter: {delimiter!r}"
            ),
            metadata={
                "encoding": encoding,
                "table_name": table_name,
                "row_count": len(rows),
                "column_count": max_columns,
                "has_header": has_header,
                "delimiter": delimiter,
            },
        )
    ]
    if not rows:
        return chunks

    table_pieces = _pack_table_rows(headers, data_rows, max_chars=max_chars, header_source_row=header_row)
    final_column = _excel_column(max_columns) if max_columns else "A"
    for piece in table_pieces:
        cell_range = f"A{piece.start}:{final_column}{piece.end}"
        display = f"{source.name} rows {piece.start}-{piece.end}"
        metadata = {
            "encoding": encoding,
            "table_name": table_name,
            "row_start": piece.start,
            "row_end": piece.end,
            "header_row": header_row,
            "has_header": has_header,
            "part_index": piece.part_index,
            "part_count": piece.part_count,
        }
        chunks.append(
            _make_chunk(
                content=piece.text,
                content_type="csv_rows",
                title_path=[source.stem, table_name, f"rows {piece.start}-{piece.end}"],
                source_ref=f"{source.name} {cell_range}",
                metadata={**metadata, "cell_range": cell_range},
                locations=[
                    {
                        "sheet_name": table_name,
                        "cell_range": cell_range,
                        "display_text": display,
                        "metadata": metadata,
                    }
                ],
            )
        )
    return chunks


def adapt_docx(path: str | Path, *, max_chars: int = DEFAULT_MAX_CHARS) -> list[dict[str, Any]]:
    """Extract DOCX body paragraphs and tables using Office Open XML."""

    source = Path(path)
    _validate_max_chars(max_chars)
    with _open_ooxml(source, "DOCX") as package:
        document_root = _read_xml_member(package, "word/document.xml", source, required=True)
        styles_root = _read_xml_member(package, "word/styles.xml", source, required=False)

    body = document_root.find(f"{_W}body")
    if body is None:
        raise FormatAdapterError(f"Invalid DOCX {source}: word/document.xml has no body")
    style_names = _word_style_names(styles_root)

    chunks: list[dict[str, Any]] = []
    content_chunks: list[dict[str, Any]] = []
    heading_stack: list[str] = []
    paragraph_buffer: list[tuple[int, str]] = []
    paragraph_path: list[str] = [source.stem, "body"]
    paragraph_number = 0
    table_number = 0

    def flush_paragraphs() -> None:
        nonlocal paragraph_buffer
        if not paragraph_buffer:
            return
        for piece in _pack_numbered_items(paragraph_buffer, max_chars=max_chars):
            display = f"{source.name} paragraphs {piece.start}-{piece.end}"
            metadata = {
                "paragraph_start": piece.start,
                "paragraph_end": piece.end,
                "heading_path": paragraph_path,
                "part_index": piece.part_index,
                "part_count": piece.part_count,
            }
            content_chunks.append(
                _make_chunk(
                    content=piece.text,
                    content_type="docx_paragraphs",
                    title_path=paragraph_path,
                    source_ref=display,
                    metadata=metadata,
                    locations=[{"display_text": display, "metadata": metadata}],
                )
            )
        paragraph_buffer = []

    for block in list(body):
        if block.tag == f"{_W}p":
            paragraph_number += 1
            paragraph_text = _word_paragraph_text(block)
            if not paragraph_text:
                continue
            heading_level = _word_heading_level(block, style_names)
            if heading_level is not None:
                flush_paragraphs()
                heading_stack = heading_stack[: heading_level - 1]
                while len(heading_stack) < heading_level - 1:
                    heading_stack.append("untitled")
                heading_stack.append(paragraph_text)
                paragraph_path = [source.stem, *heading_stack]
            elif not paragraph_buffer:
                paragraph_path = [source.stem, *heading_stack] if heading_stack else [source.stem, "body"]
            paragraph_buffer.append((paragraph_number, paragraph_text))
            continue

        if block.tag != f"{_W}tbl":
            continue
        flush_paragraphs()
        table_number += 1
        rows = _word_table_rows(block)
        if not rows:
            continue
        max_columns = max(len(row) for row in rows)
        padded_rows = [_pad_row(row, max_columns) for row in rows]
        headers = padded_rows[0]
        data_rows = [(row_index, row) for row_index, row in enumerate(padded_rows[1:], start=2)]
        if data_rows:
            pieces = _pack_table_rows(headers, data_rows, max_chars=max_chars, header_source_row=1)
        else:
            pieces = _pack_numbered_items([(1, _render_table_header(headers))], max_chars=max_chars)
        table_path = [source.stem, *heading_stack, f"table {table_number}"]
        for piece in pieces:
            display = f"{source.name} table {table_number} rows {piece.start}-{piece.end}"
            metadata = {
                "table_index": table_number,
                "row_start": piece.start,
                "row_end": piece.end,
                "column_count": max_columns,
                "heading_path": table_path,
                "part_index": piece.part_index,
                "part_count": piece.part_count,
            }
            content_chunks.append(
                _make_chunk(
                    content=piece.text,
                    content_type="docx_table",
                    title_path=table_path,
                    source_ref=display,
                    metadata=metadata,
                    locations=[{"display_text": display, "metadata": metadata}],
                )
            )

    flush_paragraphs()
    chunks.append(
        _document_summary_chunk(
            source,
            content_type="docx_document_summary",
            lines=(
                f"DOCX document: {source.name}\n"
                "Extraction method: stdlib_ooxml\n"
                f"Body paragraphs: {paragraph_number}\n"
                f"Tables: {table_number}\n"
                f"Content chunks: {len(content_chunks)}"
            ),
            metadata={
                "extraction_method": "stdlib_ooxml",
                "paragraph_count": paragraph_number,
                "table_count": table_number,
            },
        )
    )
    chunks.extend(content_chunks)
    return chunks


def adapt_pptx(path: str | Path, *, max_chars: int = DEFAULT_MAX_CHARS) -> list[dict[str, Any]]:
    """Extract ordered PPTX slide text and speaker notes using OOXML."""

    source = Path(path)
    _validate_max_chars(max_chars)
    content_chunks: list[dict[str, Any]] = []
    notes_slide_count = 0
    slides_with_text = 0

    with _open_ooxml(source, "PPTX") as package:
        presentation_root = _read_xml_member(package, "ppt/presentation.xml", source, required=True)
        presentation_rels = _read_relationships(package, "ppt/_rels/presentation.xml.rels", source, required=True)
        slide_parts = _ordered_slide_parts(presentation_root, presentation_rels, source)

        for slide_number, slide_part in enumerate(slide_parts, start=1):
            slide_root = _read_xml_member(package, slide_part, source, required=True)
            slide_paragraphs = _drawing_paragraphs(slide_root, notes=False)
            slide_title = _slide_title(slide_root) or f"slide {slide_number}"
            title_path = [source.stem, f"slide {slide_number}", slide_title]
            if slide_paragraphs:
                slides_with_text += 1
                items = list(enumerate(slide_paragraphs, start=1))
                for piece in _pack_numbered_items(items, max_chars=max_chars):
                    display = f"{source.name} slide {slide_number}"
                    metadata = {
                        "slide_number": slide_number,
                        "slide_part": slide_part,
                        "slide_title": slide_title,
                        "paragraph_start": piece.start,
                        "paragraph_end": piece.end,
                        "part_index": piece.part_index,
                        "part_count": piece.part_count,
                    }
                    content_chunks.append(
                        _make_chunk(
                            content=piece.text,
                            content_type="pptx_slide",
                            title_path=title_path,
                            source_ref=display,
                            metadata=metadata,
                            locations=[
                                {
                                    "slide_start": slide_number,
                                    "slide_end": slide_number,
                                    "display_text": display,
                                    "metadata": metadata,
                                }
                            ],
                        )
                    )

            notes_part = _notes_part_for_slide(package, slide_part, source)
            if notes_part is None:
                continue
            notes_root = _read_xml_member(package, notes_part, source, required=True)
            note_paragraphs = _drawing_paragraphs(notes_root, notes=True)
            if not note_paragraphs:
                continue
            notes_slide_count += 1
            items = list(enumerate(note_paragraphs, start=1))
            for piece in _pack_numbered_items(items, max_chars=max_chars):
                display = f"{source.name} slide {slide_number} notes"
                metadata = {
                    "slide_number": slide_number,
                    "slide_part": slide_part,
                    "notes_part": notes_part,
                    "slide_title": slide_title,
                    "paragraph_start": piece.start,
                    "paragraph_end": piece.end,
                    "part_index": piece.part_index,
                    "part_count": piece.part_count,
                }
                content_chunks.append(
                    _make_chunk(
                        content=piece.text,
                        content_type="pptx_notes",
                        title_path=[*title_path, "speaker notes"],
                        source_ref=display,
                        metadata=metadata,
                        locations=[
                            {
                                "slide_start": slide_number,
                                "slide_end": slide_number,
                                "display_text": display,
                                "metadata": metadata,
                            }
                        ],
                    )
                )

    summary = _document_summary_chunk(
        source,
        content_type="pptx_document_summary",
        lines=(
            f"PPTX presentation: {source.name}\n"
            "Extraction method: stdlib_ooxml\n"
            f"Slides: {len(slide_parts)}\n"
            f"Slides with text: {slides_with_text}\n"
            f"Slides with speaker notes: {notes_slide_count}"
        ),
        metadata={
            "extraction_method": "stdlib_ooxml",
            "slide_count": len(slide_parts),
            "slides_with_text": slides_with_text,
            "notes_slide_count": notes_slide_count,
        },
    )
    return [summary, *content_chunks]


def _validate_max_chars(max_chars: int) -> None:
    if not isinstance(max_chars, int) or max_chars < 64:
        raise ValueError("max_chars must be an integer >= 64")


def _make_chunk(
    *,
    content: str,
    content_type: str,
    title_path: Sequence[str],
    source_ref: str,
    metadata: dict[str, Any],
    locations: list[dict[str, Any]],
) -> dict[str, Any]:
    clean_content = content.strip()
    return {
        "content": clean_content,
        "content_type": content_type,
        "title_path": [str(item) for item in title_path if str(item).strip()],
        "summary": clean_content[:240],
        "source_ref": source_ref,
        "metadata": metadata,
        "locations": locations,
    }


def _document_summary_chunk(
    source: Path,
    *,
    content_type: str,
    lines: str,
    metadata: dict[str, Any],
) -> dict[str, Any]:
    return _make_chunk(
        content=lines,
        content_type=content_type,
        title_path=[source.stem, "document summary"],
        source_ref=source.name,
        metadata=metadata,
        locations=[{"display_text": source.name, "metadata": metadata}],
    )


def _read_text(source: Path) -> tuple[str, str]:
    try:
        data = source.read_bytes()
    except OSError as exc:
        raise FormatAdapterError(f"Unable to read text document {source}: {exc}") from exc

    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        candidates = ("utf-16",)
    else:
        candidates = ("utf-8-sig", "gb18030")
    for encoding in candidates:
        try:
            return data.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    raise FormatAdapterError(f"Unable to decode text document {source}; expected UTF-8, UTF-16, or GB18030")


def _hard_split(text: str, limit: int) -> list[str]:
    text = text.strip()
    if not text:
        return []
    pieces: list[str] = []
    while len(text) > limit:
        cut = max(text.rfind("\n", 0, limit + 1), text.rfind(" ", 0, limit + 1))
        if cut < max(1, limit // 2):
            cut = limit
        pieces.append(text[:cut].rstrip())
        text = text[cut:].lstrip()
    if text:
        pieces.append(text)
    return pieces


def _pack_numbered_items(
    items: Iterable[tuple[int, str]],
    *,
    max_chars: int,
    prefix: str = "",
) -> list[_PackedPiece]:
    normalized = [(number, str(text).strip()) for number, text in items if str(text).strip()]
    if not normalized:
        return []
    prefix = prefix.strip()
    if prefix and len(prefix) + 32 >= max_chars:
        prefix = ""
    available = max_chars - len(prefix) - (1 if prefix else 0)
    available = max(32, available)
    pieces: list[_PackedPiece] = []
    current: list[str] = []
    current_start = current_end = 0

    def finish() -> None:
        nonlocal current, current_start, current_end
        if not current:
            return
        body = "\n".join(current)
        content = f"{prefix}\n{body}" if prefix else body
        pieces.append(_PackedPiece(content, current_start, current_end))
        current = []
        current_start = current_end = 0

    for number, item_text in normalized:
        split_items = _hard_split(item_text, available)
        if len(split_items) > 1:
            finish()
            for part_index, split_item in enumerate(split_items, start=1):
                content = f"{prefix}\n{split_item}" if prefix else split_item
                pieces.append(
                    _PackedPiece(
                        content,
                        number,
                        number,
                        part_index=part_index,
                        part_count=len(split_items),
                    )
                )
            continue

        candidate = "\n".join([*current, item_text])
        if current and len(candidate) > available:
            finish()
        if not current:
            current_start = number
        current.append(item_text)
        current_end = number
    finish()
    return pieces


def _markdown_sections(
    lines: Sequence[str],
    document_title: str,
) -> list[tuple[list[str], list[tuple[int, str]]]]:
    sections: list[tuple[list[str], list[tuple[int, str]]]] = []
    heading_stack: list[str] = []
    current_path = [document_title, "preamble"]
    current_items: list[tuple[int, str]] = []
    fence_marker: str | None = None

    def finish() -> None:
        nonlocal current_items
        if current_items:
            sections.append((list(current_path), current_items))
        current_items = []

    for line_number, line in enumerate(lines, start=1):
        stripped = line.lstrip()
        fence = re.match(r"^(`{3,}|~{3,})", stripped)
        if fence_marker is not None:
            current_items.append((line_number, line))
            if fence and fence.group(1).startswith(fence_marker[0]) and len(fence.group(1)) >= len(fence_marker):
                fence_marker = None
            continue
        if fence:
            fence_marker = fence.group(1)
            current_items.append((line_number, line))
            continue

        heading = re.match(r"^(#{1,6})[ \t]+(.+?)\s*#*\s*$", stripped)
        if not heading:
            current_items.append((line_number, line))
            continue
        finish()
        level = len(heading.group(1))
        heading_text = heading.group(2).strip()
        heading_stack = heading_stack[: level - 1]
        while len(heading_stack) < level - 1:
            heading_stack.append("untitled")
        heading_stack.append(heading_text)
        current_path = [document_title, *heading_stack]
        current_items.append((line_number, line))
    finish()
    return sections


def _detect_csv_dialect(sample: str) -> type[csv.Dialect] | csv.Dialect:
    if not sample.strip():
        return csv.excel
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        return csv.excel


def _csv_has_header(sample: str) -> bool:
    if not sample.strip():
        return False
    try:
        return csv.Sniffer().has_header(sample)
    except csv.Error:
        return False


def _pad_row(row: Sequence[str], size: int) -> list[str]:
    return [str(value) for value in row] + [""] * max(0, size - len(row))


def _table_cell(value: Any) -> str:
    return str(value or "").replace("\r", " ").replace("\n", "<br>").replace("|", r"\|").strip()


def _render_table_row(row: Sequence[Any]) -> str:
    return "| " + " | ".join(_table_cell(value) for value in row) + " |"


def _render_table_header(headers: Sequence[Any]) -> str:
    header = _render_table_row(headers)
    separator = "| " + " | ".join("---" for _ in headers) + " |"
    return f"{header}\n{separator}"


def _pack_table_rows(
    headers: Sequence[str],
    rows: Sequence[tuple[int, Sequence[str]]],
    *,
    max_chars: int,
    header_source_row: int | None,
) -> list[_PackedPiece]:
    prefix = _render_table_header(headers)
    if not rows:
        source_row = header_source_row or 1
        return _pack_numbered_items([(source_row, prefix)], max_chars=max_chars)
    rendered_rows = [(row_number, _render_table_row(row)) for row_number, row in rows]
    return _pack_numbered_items(rendered_rows, max_chars=max_chars, prefix=prefix)


def _excel_column(index: int) -> str:
    if index <= 0:
        return "A"
    letters = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


class _OOXMLPackage:
    def __init__(self, source: Path, label: str):
        self.source = source
        self.label = label
        self.package: zipfile.ZipFile | None = None

    def __enter__(self) -> zipfile.ZipFile:
        try:
            self.package = zipfile.ZipFile(self.source)
            return self.package
        except (OSError, zipfile.BadZipFile) as exc:
            raise FormatAdapterError(f"Invalid {self.label} package {self.source}: {exc}") from exc

    def __exit__(self, exc_type, exc, traceback) -> None:
        if self.package is not None:
            self.package.close()


def _open_ooxml(source: Path, label: str) -> _OOXMLPackage:
    return _OOXMLPackage(source, label)


def _read_xml_member(
    package: zipfile.ZipFile,
    member: str,
    source: Path,
    *,
    required: bool,
) -> ET.Element | None:
    normalized = member.lstrip("/")
    try:
        info = package.getinfo(normalized)
    except KeyError as exc:
        if required:
            raise FormatAdapterError(f"Invalid OOXML document {source}: missing {normalized}") from exc
        return None
    if info.file_size > MAX_XML_MEMBER_BYTES:
        raise FormatAdapterError(
            f"Refusing oversized OOXML member {normalized} in {source} ({info.file_size} bytes)"
        )
    try:
        payload = package.read(info)
        return ET.fromstring(payload)
    except (OSError, RuntimeError, ET.ParseError) as exc:
        raise FormatAdapterError(f"Invalid XML member {normalized} in {source}: {exc}") from exc


def _word_style_names(styles_root: ET.Element | None) -> dict[str, str]:
    if styles_root is None:
        return {}
    names: dict[str, str] = {}
    for style in styles_root.findall(f".//{_W}style"):
        style_id = style.get(f"{_W}styleId") or ""
        name = style.find(f"{_W}name")
        style_name = name.get(f"{_W}val") if name is not None else ""
        if style_id and style_name:
            names[style_id] = style_name
    return names


def _word_paragraph_text(paragraph: ET.Element) -> str:
    parts: list[str] = []
    for node in paragraph.iter():
        if node.tag == f"{_W}t" and node.text:
            parts.append(node.text)
        elif node.tag == f"{_W}tab":
            parts.append("\t")
        elif node.tag in {f"{_W}br", f"{_W}cr"}:
            parts.append("\n")
    return "".join(parts).strip()


def _word_heading_level(paragraph: ET.Element, style_names: dict[str, str]) -> int | None:
    style = paragraph.find(f"./{_W}pPr/{_W}pStyle")
    if style is None:
        return None
    style_id = style.get(f"{_W}val") or ""
    style_name = style_names.get(style_id, style_id)
    match = re.search(r"(?:heading|标题)\s*([1-6])", style_name, flags=re.IGNORECASE)
    return int(match.group(1)) if match else None


def _word_table_rows(table: ET.Element) -> list[list[str]]:
    rows: list[list[str]] = []
    for row in table.findall(f"./{_W}tr"):
        values: list[str] = []
        for cell in row.findall(f"./{_W}tc"):
            paragraphs = [_word_paragraph_text(paragraph) for paragraph in cell.findall(f".//{_W}p")]
            values.append("\n".join(text for text in paragraphs if text).strip())
        if any(value for value in values):
            rows.append(values)
    return rows


def _read_relationships(
    package: zipfile.ZipFile,
    member: str,
    source: Path,
    *,
    required: bool,
) -> dict[str, dict[str, str]]:
    root = _read_xml_member(package, member, source, required=required)
    if root is None:
        return {}
    relationships: dict[str, dict[str, str]] = {}
    for relationship in root.findall(f".//{_PKG_REL}Relationship"):
        relationship_id = relationship.get("Id") or ""
        if relationship_id:
            relationships[relationship_id] = {
                "target": relationship.get("Target") or "",
                "type": relationship.get("Type") or "",
                "target_mode": relationship.get("TargetMode") or "",
            }
    return relationships


def _resolve_ooxml_target(source_part: str, target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join(posixpath.dirname(source_part), target)).lstrip("/")


def _ordered_slide_parts(
    presentation_root: ET.Element,
    relationships: dict[str, dict[str, str]],
    source: Path,
) -> list[str]:
    parts: list[str] = []
    for slide_id in presentation_root.findall(f".//{_P}sldId"):
        relationship_id = slide_id.get(f"{_R}id") or ""
        relationship = relationships.get(relationship_id)
        if relationship is None:
            raise FormatAdapterError(
                f"Invalid PPTX {source}: slide relationship {relationship_id or '(missing id)'} was not found"
            )
        if relationship.get("target_mode", "").lower() == "external":
            raise FormatAdapterError(f"Invalid PPTX {source}: slide {relationship_id} points to an external target")
        target = relationship.get("target") or ""
        if not target:
            raise FormatAdapterError(f"Invalid PPTX {source}: slide {relationship_id} has no target")
        parts.append(_resolve_ooxml_target("ppt/presentation.xml", target))
    return parts


def _drawing_paragraph_text(paragraph: ET.Element) -> str:
    parts: list[str] = []
    for node in paragraph.iter():
        if node.tag == f"{_A}t" and node.text:
            parts.append(node.text)
        elif node.tag == f"{_A}tab":
            parts.append("\t")
        elif node.tag == f"{_A}br":
            parts.append("\n")
    return "".join(parts).strip()


def _shape_placeholder_type(shape: ET.Element) -> str:
    placeholder = shape.find(f"./{_P}nvSpPr/{_P}nvPr/{_P}ph")
    return (placeholder.get("type") if placeholder is not None else "") or ""


def _drawing_paragraphs(root: ET.Element, *, notes: bool) -> list[str]:
    excluded_note_placeholders = {"sldImg", "sldNum", "hdr", "ftr", "dt"}
    paragraphs: list[str] = []
    seen: set[int] = set()
    for shape in root.findall(f".//{_P}sp"):
        if notes and _shape_placeholder_type(shape) in excluded_note_placeholders:
            continue
        for paragraph in shape.findall(f".//{_A}p"):
            seen.add(id(paragraph))
            text = _drawing_paragraph_text(paragraph)
            if text:
                paragraphs.append(text)
    # Table cells and other graphic frames are not p:sp descendants.
    for paragraph in root.iter(f"{_A}p"):
        if id(paragraph) in seen:
            continue
        text = _drawing_paragraph_text(paragraph)
        if text:
            paragraphs.append(text)
    return paragraphs


def _slide_title(slide_root: ET.Element) -> str:
    for shape in slide_root.findall(f".//{_P}sp"):
        if _shape_placeholder_type(shape) not in {"title", "ctrTitle"}:
            continue
        title = " ".join(
            text
            for text in (_drawing_paragraph_text(paragraph) for paragraph in shape.findall(f".//{_A}p"))
            if text
        ).strip()
        if title:
            return title
    return ""


def _relationship_member_for_part(part: str) -> str:
    directory, filename = posixpath.split(part)
    return posixpath.join(directory, "_rels", f"{filename}.rels")


def _notes_part_for_slide(package: zipfile.ZipFile, slide_part: str, source: Path) -> str | None:
    relationships = _read_relationships(
        package,
        _relationship_member_for_part(slide_part),
        source,
        required=False,
    )
    for relationship in relationships.values():
        if relationship.get("target_mode", "").lower() == "external":
            continue
        if relationship.get("type", "").endswith("/notesSlide"):
            target = relationship.get("target") or ""
            if target:
                return _resolve_ooxml_target(slide_part, target)
    return None


_ADAPTERS: dict[str, Callable[..., list[dict[str, Any]]]] = {
    ".docx": adapt_docx,
    ".pptx": adapt_pptx,
    ".csv": adapt_csv,
    ".md": adapt_markdown,
    ".markdown": adapt_markdown,
    ".txt": adapt_text,
}


__all__ = [
    "DEFAULT_MAX_CHARS",
    "FormatAdapterError",
    "SUPPORTED_EXTENSIONS",
    "UnsupportedFormatError",
    "adapt_csv",
    "adapt_document",
    "adapt_docx",
    "adapt_markdown",
    "adapt_pptx",
    "adapt_text",
    "supports_path",
]
