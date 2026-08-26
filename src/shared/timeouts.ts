import { config } from './config.ts';
import type { Stage } from './job.ts';

const STAGE_TIMEOUTS: Record<Stage, number> = Object.freeze({
  downloading: 10 * 60 * 1000,
  converting: 15 * 60 * 1000,
  transcribing: 25 * 60 * 1000,
  summarizing: 10 * 60 * 1000,
});

export function stageTimeoutMs(stage: Stage | string): number {
  return STAGE_TIMEOUTS[stage as Stage] || config.jobTimeoutMs;
}
