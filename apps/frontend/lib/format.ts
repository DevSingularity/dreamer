/** "3h ago", "just now", etc. — falls back to a locale date past 30 days. */
export function formatRelativeTime(date: string | Date): string {
  const then = new Date(date).getTime();
  const diffSeconds = Math.round((Date.now() - then) / 1000);

  if (diffSeconds < 5) return "just now";
  if (diffSeconds < 60) return `${diffSeconds}s ago`;

  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;

  return new Date(date).toLocaleDateString();
}

/** "2m 34s", "45s", "1h 02m" — for buildDurationMs and the state timeline. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** "owner/repo" -> "repo" — used to auto-suggest a project name from a pasted GitHub URL. */
export function repoNameFromUrl(repoUrl: string): string {
  const match = repoUrl.match(/\/([^/]+?)(\.git)?\/?$/);
  return match?.[1] ?? "";
}
