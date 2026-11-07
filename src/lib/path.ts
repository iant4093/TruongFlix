/** Last segment of a Windows or POSIX path, ignoring trailing separators. */
export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
