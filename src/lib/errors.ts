/** Readable text for anything thrown or rejected. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
