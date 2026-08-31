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

export interface CreatePeProjectInput {
  name: string;
  companyName?: string;
  companyTicker?: string;
}
