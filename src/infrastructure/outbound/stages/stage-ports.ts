/**
 * Worker stage-port adapters (phase 2C).
 * Wraps the real subprocess/HTTP stage functions behind the application
 * ports so `worker/pipeline.ts` only depends on the port contracts.
 */
import type { RuntimeConfig } from '../../../application/config.ts';
import type { PipelineStagePorts, StageContext } from '../../../application/ports/stage-ports.ts';
import { convert } from './convert.ts';
import { download } from './download.ts';
import { summarize } from './summarize.ts';
import { transcribe } from './transcribe.ts';

export interface PipelineStageFunctions {
  download: typeof download;
  convert: typeof convert;
  transcribe: typeof transcribe;
  summarize: typeof summarize;
}

const defaultStageFunctions: PipelineStageFunctions = { download, convert, transcribe, summarize };

function contextOf(input: {
  jobDir: string;
  logPath: string;
  onHeartbeat?: () => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}): StageContext {
  return {
    jobDir: input.jobDir,
    logPath: input.logPath,
    onHeartbeat: input.onHeartbeat,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  };
}

export function createPipelineStagePorts(
  stageFunctions: PipelineStageFunctions = defaultStageFunctions,
  runtimeConfig?: RuntimeConfig,
): PipelineStagePorts {
  return {
    downloader: {
      download: (input) => stageFunctions.download({ url: input.url }, contextOf(input), runtimeConfig),
    },
    converter: {
      convert: (input) => stageFunctions.convert(input.audioPath, contextOf(input)),
    },
    transcriber: {
      transcribe: (input) => stageFunctions.transcribe(input.wavPath, contextOf(input), runtimeConfig),
    },
    summarizer: {
      summarize: (input) =>
        stageFunctions.summarize(input.transcriptPath, { ...contextOf(input), lang: input.lang }, runtimeConfig),
    },
  };
}
