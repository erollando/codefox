import { describe, expect, it } from "vitest";
import { RepoRegistry } from "../src/core/repo-registry.js";

describe("RepoRegistry", () => {
  const repos = new RepoRegistry([
    {
      name: "payments-api",
      rootPath: "/tmp/work/payments-api"
    }
  ]);

  it("returns configured repo", () => {
    const repo = repos.get("payments-api");
    expect(repo.name).toBe("payments-api");
  });

  it("rejects path traversal", () => {
    expect(() => repos.ensurePathWithinRepo("payments-api", "../../etc/passwd")).toThrowError(
      /Path escapes/
    );
  });

  it("accepts in-repo path", () => {
    const resolved = repos.ensurePathWithinRepo("payments-api", "src/index.ts");
    expect(resolved.endsWith("payments-api/src/index.ts")).toBe(true);
  });

  it("supports add/remove for runtime repo registry updates", () => {
    const dynamic = new RepoRegistry([{ name: "a", rootPath: "/tmp/work/a" }]);
    dynamic.add({ name: "b", rootPath: "/tmp/work/b" });
    expect(dynamic.has("b")).toBe(true);
    dynamic.remove("b");
    expect(dynamic.has("b")).toBe(false);
  });

  it("rejects overlapping repository roots at construction", () => {
    expect(
      () =>
        new RepoRegistry([
          { name: "root", rootPath: "/tmp/work/project" },
          { name: "child", rootPath: "/tmp/work/project/packages/a" }
        ])
    ).toThrowError(/Overlapping repository roots/);
  });
});
