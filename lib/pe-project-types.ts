export interface PeProjectSummary {
  datasetId: string;
  name: string;
  status: string;
  root: string;
  projectKey: string;
  companyName: string;
  companyTicker: string;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PeProjectCatalog {
  projects: PeProjectSummary[];
  activeDatasetId: string | null;
}

export type PeProjectDocumentStatus =
  | "queued"
  | "running"
  | "completed"
  | "completed_with_warnings"
  | "failed";

export interface PeProjectDocumentSummary {
  filename: string;
  title?: string;
  brokerage?: string;
  documentDate?: string;
  rating?: string;
  targetPrice?: string;
  docId?: string;
  fileType: string;
  versionNo?: number;
  isCurrent?: boolean;
  status: PeProjectDocumentStatus;
  pageCount: number;
  sizeBytes: number | null;
  uploadedAt: string;
  updatedAt: string;
  warningCount: number;
  warnings: string[];
  needsOcrPageCount: number;
  sheetCount: number;
  formulaCount: number;
  retryable: boolean;
  rawRelativePath: string | null;
  markdownRelativePath: string | null;
}

export interface PeProjectDocumentCatalog {
  documents: PeProjectDocumentSummary[];
  currentCount?: number;
}

export interface CreatePeProjectInput {
  name: string;
  companyName?: string;
  companyTicker?: string;
}
