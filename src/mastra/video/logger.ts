/**
 * Stage logging for the video pipeline. Deliberately logs only stage names
 * and small scalars (paths, counts, durations) - never image/video bytes,
 * base64 payloads, or full backend response bodies.
 */
export function logStage(stage: string, detail?: Record<string, string | number | boolean | undefined>): void {
  const suffix =
    detail && Object.keys(detail).length > 0
      ? ' ' +
        Object.entries(detail)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')
      : '';
  console.log(`[video-transform] ${stage}${suffix}`);
}
