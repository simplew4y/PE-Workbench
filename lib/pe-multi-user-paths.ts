import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export function isPeMultiUserMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes", "on"].includes(env.PE_MULTI_USER_MODE?.trim().toLowerCase() ?? "");
}

export function getPeUserRoot(
  env: NodeJS.ProcessEnv = process.env,
  defaultHome = homedir(),
): string {
  const configured = env.PE_USER_ROOT?.trim() || defaultHome;
  if (!isAbsolute(configured)) throw new Error("PE_USER_ROOT must be an absolute path");
  try {
    return realpathSync(configured);
  } catch {
    throw new Error(`PE user root does not exist: ${configured}`);
  }
}

function isInside(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function nearestExistingAncestor(target: string): string | null {
  let current = target;
  for (;;) {
    if (existsSync(current)) {
      try {
        return realpathSync(current);
      } catch {
        return null;
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function isPeUserPathAllowed(
  target: string,
  env: NodeJS.ProcessEnv = process.env,
  defaultHome = homedir(),
): boolean {
  if (!isPeMultiUserMode(env)) return true;
  const root = getPeUserRoot(env, defaultHome);
  const candidate = resolve(target);
  if (!isInside(root, candidate)) return false;
  const realAncestor = nearestExistingAncestor(candidate);
  return realAncestor !== null && isInside(root, realAncestor);
}

export function assertPeUserPathAllowed(target: string): void {
  if (!isPeUserPathAllowed(target)) throw new Error("Path is outside the current PE user workspace");
}
