import type { PermissionMode } from "../shared/types";

export const COMPOSER_MEMORY_PREFIX = "tacode.composer.";

const PERMISSION_MODES: readonly PermissionMode[] = ["plan", "ask", "auto", "full"];

export interface ProjectComposerMemory {
  mode?: PermissionMode;
  model?: string;
}

export function composerMemoryKey(cwd: string): string {
  return `${COMPOSER_MEMORY_PREFIX}${cwd}`;
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** 按项目读取上次的模式/模型；缺项目路径、记录损坏或存储不可读时返回空对象。 */
export function readProjectComposerMemory(cwd: string): ProjectComposerMemory {
  if (!cwd) return {};
  try {
    const raw = localStorage.getItem(composerMemoryKey(cwd));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const memory: ProjectComposerMemory = {};
    if (isPermissionMode(record.mode)) memory.mode = record.mode;
    if (typeof record.model === "string" && record.model.trim()) memory.model = record.model.trim();
    return memory;
  } catch {
    return {};
  }
}

/** 合并写入该项目记忆；空路径与存储不可写都静默忽略。 */
export function writeProjectComposerMemory(cwd: string, patch: ProjectComposerMemory): void {
  if (!cwd) return;
  try {
    const merged = { ...readProjectComposerMemory(cwd), ...patch };
    localStorage.setItem(composerMemoryKey(cwd), JSON.stringify(merged));
  } catch {
    // Ignore private mode / quota failures.
  }
}
