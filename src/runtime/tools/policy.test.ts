import { describe, expect, it } from "vitest";
import { classifyCommand, commandNeedsNetwork, SessionAccessController } from "./policy";

describe("classifyCommand", () => {
  it("treats simple inspection commands as read-only", () => {
    expect(classifyCommand("ls -la")).toBe("read-only");
    expect(classifyCommand("rg --files")).toBe("read-only");
    expect(classifyCommand("git status")).toBe("read-only");
  });

  it("flags shell syntax and writes as needing approval", () => {
    expect(classifyCommand("npm test")).toBe("needs-approval");
    expect(classifyCommand("ls | cat")).toBe("needs-approval");
    expect(classifyCommand("git commit -m x")).toBe("needs-approval");
    expect(classifyCommand("sed -i s/a/b/ a.txt")).toBe("needs-approval");
  });

  it("flags destructive commands", () => {
    expect(classifyCommand("rm -rf dist")).toBe("dangerous");
    expect(classifyCommand("git reset --hard")).toBe("dangerous");
    expect(classifyCommand("sudo rm file")).toBe("dangerous");
  });
});

describe("commandNeedsNetwork", () => {
  it("detects network-reaching commands", () => {
    expect(commandNeedsNetwork("curl https://example.com")).toBe(true);
    expect(commandNeedsNetwork("git push origin main")).toBe(true);
    expect(commandNeedsNetwork("pnpm install")).toBe(true);
    expect(commandNeedsNetwork("ls -la")).toBe(false);
  });
});

describe("SessionAccessController", () => {
  it("downgrades to read-only in plan mode and upgrades in full mode", () => {
    const access = new SessionAccessController("workspace-write", false);
    expect(access.effective("plan")).toEqual({ sandbox: "read-only", network: false });
    expect(access.effective("auto")).toEqual({ sandbox: "workspace-write", network: false });
    expect(access.effective("full")).toEqual({ sandbox: "danger-full-access", network: true });
  });

  it("keeps session grants scoped to the conversation", () => {
    const access = new SessionAccessController("workspace-write", false);
    access.grantForSession("network");
    expect(access.effective("auto").network).toBe(true);
    expect(access.describeGrants()).toContain("network (conversation)");

    access.grantForSession("host");
    expect(access.forCommand("auto", "ls").sandbox).toBe("danger-full-access");
  });

  it("never grants host access while in plan mode", () => {
    const access = new SessionAccessController("workspace-write", false);
    access.grantForSession("host");
    expect(access.forCommand("plan", "ls")).toEqual({ sandbox: "read-only", network: false });
  });
});
