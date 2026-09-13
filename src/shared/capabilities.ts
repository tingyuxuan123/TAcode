import type { McpServerRow } from "./integrations";

export type CapabilityScope = "project" | "user";

/** 身份不含 active/inactive，切换开关后仍指向同一个技能。 */
export interface ManagedSkill {
  id: string;
  name: string;
  description: string;
  version?: string;
  group?: string;
  scope: CapabilityScope;
  rootLabel: string;
  path: string;
  enabled: boolean;
  warning?: string;
}

export interface SkillsSnapshot {
  skills: ManagedSkill[];
  projectTrusted: boolean;
}

export interface SkillDocument {
  skill: ManagedSkill;
  content: string;
  files: string[];
}

export interface SkillImportResult {
  imported: string[];
  skipped: string[];
  errors: string[];
}

export interface McpToolSummary {
  name: string;
  description?: string;
}

export interface McpTestResult {
  success: boolean;
  message: string;
  tools: McpToolSummary[];
  checkedAt: number;
}

export interface McpSnapshot {
  servers: McpServerRow[];
  configPath: string;
  projectTrusted: boolean;
}

export interface CapabilitiesApi {
  trustProject(cwd: string): Promise<void>;
  onChanged(listener: (cwd?: string) => void): () => void;
}

export interface SkillsApi {
  list(cwd?: string): Promise<SkillsSnapshot>;
  read(id: string, cwd?: string): Promise<SkillDocument>;
  create(content: string, scope: CapabilityScope, cwd?: string): Promise<ManagedSkill>;
  save(id: string, content: string, previousContent: string, cwd?: string): Promise<ManagedSkill>;
  setEnabled(id: string, enabled: boolean, cwd?: string): Promise<ManagedSkill>;
  remove(id: string, cwd?: string): Promise<void>;
  import(scope: CapabilityScope, cwd?: string): Promise<SkillImportResult | null>;
  reveal(id: string, cwd?: string): Promise<void>;
  readFile(id: string, file: string, cwd?: string): Promise<string>;
  saveFile(id: string, file: string, content: string, previousContent: string, cwd?: string): Promise<void>;
}

export interface McpApi {
  list(scope: CapabilityScope, cwd?: string): Promise<McpSnapshot>;
  save(server: McpServerRow, previousName: string | undefined, scope: CapabilityScope, cwd?: string): Promise<void>;
  setEnabled(name: string, enabled: boolean, scope: CapabilityScope, cwd?: string): Promise<void>;
  remove(name: string, scope: CapabilityScope, cwd?: string): Promise<void>;
  import(json: string, scope: CapabilityScope, cwd?: string): Promise<number>;
  test(server: McpServerRow, cwd?: string): Promise<McpTestResult>;
  reveal(scope: CapabilityScope, cwd?: string): Promise<void>;
}
