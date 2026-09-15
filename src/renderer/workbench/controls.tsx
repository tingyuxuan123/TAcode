import { ChevronRight } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function WorkbenchButton({ label, children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button type="button" className={`workbench-button ${className}`} title={label} aria-label={label} {...props}>{children}</button>;
}

export function WorkbenchBreadcrumb({ projectName, path }: { projectName?: string; path: string }) {
  const parts = [...(projectName ? [projectName] : []), ...path.split("/")];
  return <span className="workbench-breadcrumb" title={parts.join(" / ")}>
    {parts.map((part, index) => <span key={index} className={index === parts.length - 1 ? "is-current" : undefined}>
      {index > 0 && <ChevronRight size={13} aria-hidden="true" />}<span>{part}</span>
    </span>)}
  </span>;
}

export function WorkbenchStats({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="workbench-stats"><span className="workbench-additions">+{additions}</span><span className="workbench-deletions">−{deletions}</span></span>;
}
