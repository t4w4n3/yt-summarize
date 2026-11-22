/**
 * Dedup policy — same video plus same output language reuses the existing
 * job instead of creating a second one (phase 1C). Only `queued`, `running`
 * and `done` jobs count; `failed` ones are never reused. Legacy NULL langs
 * count as `en`.
 */
import { type JobStatus, STATUS } from './entity.ts';

export const DEDUP_STATUSES: readonly JobStatus[] = [STATUS.QUEUED, STATUS.RUNNING, STATUS.DONE];

export function isDedupEligibleStatus(status: string): boolean {
  return (DEDUP_STATUSES as readonly string[]).includes(status);
}

/** Lower wins. Failed is not eligible and ranks last. */
export function dedupRank(status: string): number {
  if (status === STATUS.DONE) return 0;
  if (status === STATUS.RUNNING) return 1;
  if (status === STATUS.QUEUED) return 2;
  return Number.POSITIVE_INFINITY;
}

export function dedupKey(videoId: string | null, lang: string | null): string | null {
  if (!videoId) return null;
  return `${videoId}|${lang ?? 'en'}`;
}
