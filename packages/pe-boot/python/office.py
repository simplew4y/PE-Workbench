"""Reuse the existing OOXML readers; preserve document blocks without chunking."""
from __future__ import annotations

import posixpath
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

MAX_XML_MEMBER_BYTES = 64 * 1024 * 1024

class FormatAdapterError(RuntimeError):
    """Raised when a supported source cannot be parsed safely."""

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

def read_office(source: Path) -> list[dict[str, object]]:
    blocks: list[dict[str, object]] = []
    with _open_ooxml(source, source.suffix) as package:
        if source.suffix.lower() == '.docx':
            document = _read_xml_member(package, 'word/document.xml', source, required=True)
            body = document.find(f'{_W}body')
            if body is None:
                raise FormatAdapterError('DOCX has no document body')
            for index, element in enumerate(body, 1):
                if element.tag == f'{_W}p':
                    text = _word_paragraph_text(element)
                elif element.tag == f'{_W}tbl':
                    text = '\n'.join('\t'.join(row) for row in _word_table_rows(element))
                else:
                    continue
                if text:
                    blocks.append({'block_index': index, 'text': text})
        else:
            presentation = _read_xml_member(package, 'ppt/presentation.xml', source, required=True)
            relationships = _read_relationships(package, 'ppt/_rels/presentation.xml.rels', source, required=True)
            for number, part in enumerate(_ordered_slide_parts(presentation, relationships, source), 1):
                slide = _read_xml_member(package, part, source, required=True)
                paragraphs = _drawing_paragraphs(slide, notes=False)
                notes_part = _notes_part_for_slide(package, part, source)
                if notes_part:
                    notes = _read_xml_member(package, notes_part, source, required=True)
                    notes_text = _drawing_paragraphs(notes, notes=True)
                    if notes_text:
                        paragraphs.extend(['Speaker notes:', *notes_text])
                blocks.append({'block_index': number, 'heading_path': f'Slide {number}: {_slide_title(slide)}', 'text': '\n'.join(paragraphs)})
    return blocks
