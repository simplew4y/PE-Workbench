/** Display-only cleanup: retain dates, numeric identifiers, and the original extension. */
export function sourceDisplayName(filename: string, title?: string): string {
  if (title?.trim() && title.trim() !== filename) return title.trim();
  return filename.replace(/-([a-f0-9]{8,64})(\.[^.]+)$/i, (suffix, hash: string, extension: string) =>
    /[a-f]/i.test(hash) && /\d/.test(hash) ? extension : suffix);
}
