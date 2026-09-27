/** Explicitly opt in only for a single-owner, loopback-bound desktop process.
 * This never changes filesystem roots or grants access to cloud APIs.
 */
export function isPeDesktopMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes", "on"].includes(env.PE_DESKTOP_MODE?.trim().toLowerCase() ?? "");
}
