import path from "node:path";
import { RepoError } from "./errors.js";
import type { RepoConfig } from "../types/domain.js";

export class RepoRegistry {
  private readonly byName = new Map<string, RepoConfig>();

  constructor(repos: RepoConfig[]) {
    assertNoOverlappingRepoRoots(repos);

    for (const repo of repos) {
      this.byName.set(repo.name, {
        ...repo,
        rootPath: path.resolve(repo.rootPath)
      });
    }
  }

  list(): RepoConfig[] {
    return [...this.byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  get(name: string): RepoConfig {
    const repo = this.byName.get(name);
    if (!repo) {
      throw new RepoError(`Unknown repository '${name}'`);
    }
    return repo;
  }

  ensurePathWithinRepo(repoName: string, candidatePath: string): string {
    const repo = this.get(repoName);
    const resolvedCandidate = path.resolve(repo.rootPath, candidatePath);
    const relative = path.relative(repo.rootPath, resolvedCandidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new RepoError(`Path escapes repository root: ${candidatePath}`);
    }
    return resolvedCandidate;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  add(repo: RepoConfig): RepoConfig {
    if (this.byName.has(repo.name)) {
      throw new RepoError(`Repository '${repo.name}' already exists`);
    }

    const candidate: RepoConfig = {
      name: repo.name,
      rootPath: path.resolve(repo.rootPath)
    };

    const next = [...this.byName.values(), candidate];
    assertNoOverlappingRepoRoots(next);

    this.byName.set(candidate.name, candidate);
    return candidate;
  }

  remove(name: string): RepoConfig {
    const existing = this.byName.get(name);
    if (!existing) {
      throw new RepoError(`Unknown repository '${name}'`);
    }
    this.byName.delete(name);
    return existing;
  }
}

function normalizePathForCompare(inputPath: string): string {
  return process.platform === "win32" ? inputPath.toLowerCase() : inputPath;
}

function isWithinPath(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  if (relative === "") {
    return true;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assertNoOverlappingRepoRoots(repos: RepoConfig[]): void {
  for (let i = 0; i < repos.length; i += 1) {
    for (let j = i + 1; j < repos.length; j += 1) {
      const left = repos[i];
      const right = repos[j];
      const leftPath = normalizePathForCompare(path.resolve(left.rootPath));
      const rightPath = normalizePathForCompare(path.resolve(right.rootPath));

      if (isWithinPath(leftPath, rightPath) || isWithinPath(rightPath, leftPath)) {
        throw new RepoError(
          `Overlapping repository roots are not allowed: '${left.name}' and '${right.name}'`
        );
      }
    }
  }
}
