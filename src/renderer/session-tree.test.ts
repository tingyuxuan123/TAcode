import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../shared/types";
import { branchAutoExpanded, groupDelegatedSessions } from "./session-tree";

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    path: "/s/parent",
    storagePath: "/store/parent",
    id: "parent",
    cwd: "/ws",
    title: "Parent",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    messageCount: 0,
    pinned: false,
    archived: false,
    ...overrides,
  };
}

describe("groupDelegatedSessions", () => {
  it("把委派子会话嵌套到父会话下", () => {
    const parent = summary();
    const childA = summary({
      path: "/s/a",
      storagePath: "/store/a",
      id: "a",
      title: "Agent A",
      sourceDelegationId: "d1",
      parentSessionPath: "/s/parent",
      delegationRole: "explorer",
    });
    const childB = summary({
      path: "/s/b",
      storagePath: "/store/b",
      id: "b",
      title: "Agent B",
      sourceDelegationId: "d2",
      parentSessionPath: "/s/parent",
      delegationRole: "reviewer",
    });
    const tree = groupDelegatedSessions([parent, childA, childB]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.session.id).toBe("parent");
    expect(tree[0]!.children.map((child) => child.id)).toEqual(["a", "b"]);
  });

  it("父会话不在列表时子会话保持平铺", () => {
    const orphan = summary({
      path: "/s/a",
      storagePath: "/store/a",
      id: "a",
      sourceDelegationId: "d1",
      parentSessionPath: "/s/gone",
    });
    const normal = summary({ path: "/s/other", storagePath: "/store/other", id: "other" });
    const tree = groupDelegatedSessions([orphan, normal]);
    expect(tree.map((item) => item.session.id)).toEqual(["a", "other"]);
    expect(tree[0]!.children).toHaveLength(0);
  });

  it("普通会话不受影响", () => {
    const a = summary({ path: "/s/a", storagePath: "/store/a", id: "a" });
    const b = summary({ path: "/s/b", storagePath: "/store/b", id: "b" });
    expect(groupDelegatedSessions([a, b]).map((item) => item.session.id)).toEqual(["a", "b"]);
  });
});

describe("branchAutoExpanded", () => {
  const child = summary({
    path: "/s/a",
    storagePath: "/store/a",
    id: "a",
    sourceDelegationId: "d1",
    parentSessionPath: "/s/parent",
  });

  it("父会话活跃时展开", () => {
    expect(branchAutoExpanded({
      children: [child],
      isActive: () => false,
      isRunning: () => false,
      isParentActive: () => true,
    })).toBe(true);
  });

  it("子会话活跃或运行中时展开", () => {
    expect(branchAutoExpanded({
      children: [child],
      isActive: (session) => session.id === "a",
      isRunning: () => false,
      isParentActive: () => false,
    })).toBe(true);
    expect(branchAutoExpanded({
      children: [child],
      isActive: () => false,
      isRunning: (session) => session.id === "a",
      isParentActive: () => false,
    })).toBe(true);
  });

  it("默认收起", () => {
    expect(branchAutoExpanded({
      children: [child],
      isActive: () => false,
      isRunning: () => false,
      isParentActive: () => false,
    })).toBe(false);
  });
});
