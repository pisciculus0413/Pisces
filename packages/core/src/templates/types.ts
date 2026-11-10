export interface TemplateInfo {
  id: string;
  name: string;
  description?: string;
}

export interface TemplatePreview {
  directories: string[];
  files: { path: string; content: string }[];
  conflicts: string[];
  initScript?: { command: string; args: string[]; timeoutMs: number };
}

export interface ProjectRef {
  id: string;
  templateId: string;
  workspace: string;
  createdAt: string;
}
