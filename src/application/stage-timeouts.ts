import type { Stage } from '../domain/job/entity.ts';

const STAGE_TIMEOUTS: Record<Stage, number> = Object.freeze({
  downloading: 10 * 60 * 1000,
  converting: 15 * 60 * 1000,
  transcribing: 25 * 60 * 1000,
  summarizing: 10 * 60 * 1000,
});

/**
 * Application timeout policy. The worker passes the configured `jobTimeoutMs`
 * as the fallback for unknown stages; known stages keep their fixed ceilings.
 */
export function stageTimeoutMs(stage: Stage | string, jobTimeoutMs?: number): number {
  return STAGE_TIMEOUTS[stage as Stage] || jobTimeoutMs || 0;
}
