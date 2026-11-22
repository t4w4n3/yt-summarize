import type { Stage } from '../domain/job/entity.ts';
import { config } from './config.ts';

const STAGE_TIMEOUTS: Record<Stage, number> = Object.freeze({
  downloading: 10 * 60 * 1000,
  converting: 15 * 60 * 1000,
  transcribing: 25 * 60 * 1000,
  summarizing: 10 * 60 * 1000,
});

export function stageTimeoutMs(stage: Stage | string, jobTimeoutMs?: number): number {
  return STAGE_TIMEOUTS[stage as Stage] || jobTimeoutMs || config.jobTimeoutMs;
}
