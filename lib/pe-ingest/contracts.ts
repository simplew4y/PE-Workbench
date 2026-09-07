export const PE_PIPELINE_SCHEMA_VERSION = 4;
export const PE_PDF_PARSER_NAME = "pdfjs-dist";
export const PE_PDF_PARSER_VERSION = "6.3.289";
export const PE_MAX_PDF_PAGES = 300;

export const PE_INGEST_STATUSES = [
  "queued",
  "running",
  "completed",
  "completed_with_warnings",
  "failed",
] as const;

export type PeIngestStatus = typeof PE_INGEST_STATUSES[number];
export type PePdfTextQuality = "passed" | "needs_ocr";
export type PePdfPageRole =
  | "cover"
  | "body"
  | "exhibit_chart"
  | "exhibit_image"
  | "table_heavy"
  | "rating_history"
  | "valuation_method"
  | "disclosure_boilerplate";
export type PePdfBlockType = "body" | "heading" | "speaker" | "table_row";

export interface PeIngestInputFile {
  originalFilename: string;
  rawPath: string;
  sha256: string;
  fileType: "pdf" | "xlsx" | "xlsm";
  docId?: string;
  registrationKind?: "pipeline" | "catalog";
}

export interface PeIngestFileResult {
  originalFilename: string;
  status: "created" | "failed";
  docId?: string;
  warningCount?: number;
  warnings?: string[];
  error?: string;
}

export interface PeIngestJobResult {
  files: PeIngestFileResult[];
  createdCount: number;
  failedCount: number;
}

export interface PeIngestJob {
  jobId: string;
  datasetId: string;
  status: PeIngestStatus;
  message: string;
  files: PeIngestInputFile[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  workerPid?: number;
  heartbeatAt?: string;
  result: PeIngestJobResult;
  warnings: string[];
}

export interface PePdfTextToken {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName: string;
  direction: string;
  hasEol: boolean;
}

export interface PePdfLine {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontNames: string[];
  directions: string[];
  columnNo: 0 | 1 | 2;
  readingOrder: number;
}

export interface PePdfBlock {
  blockId: string;
  blockIndex: number;
  blockType: PePdfBlockType;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  readingOrder: number;
  columnNo: 0 | 1 | 2;
  fontNames: string[];
  directions: string[];
}

export interface PePdfImageStatistics {
  embeddedImageCount: number;
  largeEmbeddedImageCount: number;
  drawingOperatorCount: number;
}

export interface PePdfRoleSignals {
  matchedKeywords: string[];
  numericLineRatio: number;
  tableLineRatio: number;
  embeddedImageCount: number;
  largeEmbeddedImageCount: number;
  drawingOperatorCount: number;
}

export interface PePdfQualitySignals {
  characterCount: number;
  replacementCharacterRatio: number;
  suspiciousCharacterRatio: number;
  readableCharacterRatio: number;
  reasons: string[];
}

export interface PePdfPageArtifact {
  pageId: string;
  pageNumber: number;
  role: PePdfPageRole;
  roleSignals: PePdfRoleSignals;
  width: number;
  height: number;
  rotation: number;
  text: string;
  pageHeader: string;
  textQuality: PePdfTextQuality;
  qualitySignals: PePdfQualitySignals;
  imagePaths: string[];
  imageStatistics: PePdfImageStatistics;
  blocks: PePdfBlock[];
}

export interface PePdfDocumentMetadata {
  title: string;
  brokerage: string;
  documentDate: string;
  rating: string;
  targetPrice: string;
  exhibits: string[];
  pdfMetadata: Record<string, string>;
}

export interface PeParsedPdfDocument {
  docId: string;
  datasetId: string;
  originalFilename: string;
  rawPath: string;
  sha256: string;
  parserName: string;
  parserVersion: string;
  metadata: PePdfDocumentMetadata;
  pages: PePdfPageArtifact[];
  artifactDirectory: string;
  documentMarkdownPath: string;
  layoutJsonPath: string;
  warnings: string[];
  registrationKind?: "pipeline" | "catalog";
  artifactGeneration?: string;
}
