/**
 * Fine-grained outbound stage ports. Producers hand in application-level
 * inputs; stage adapters own subprocesses, HTTP, provider details and the
 * filesystem. `PipelineStagePorts` is the thin facade over these ports.
 */
export interface StageContext {
  jobDir: string;
  logPath: string;
  onHeartbeat?: () => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DownloadInput extends StageContext {
  jobId: string;
  url: string;
}

export interface DownloadResult {
  audioPath: string;
  title: string;
}

export interface DownloaderPort {
  download(input: DownloadInput): Promise<DownloadResult>;
}

export interface ConvertInput extends StageContext {
  audioPath: string;
}

export interface AudioConverterPort {
  convert(input: ConvertInput): Promise<string>;
}

export interface TranscribeInput extends StageContext {
  wavPath: string;
}

export interface TranscriberPort {
  transcribe(input: TranscribeInput): Promise<string>;
}

export interface SummarizeInput extends StageContext {
  transcriptPath: string;
  lang?: string;
}

export interface SummarizerPort {
  summarize(input: SummarizeInput): Promise<string>;
}

export interface PipelineStagePorts {
  downloader: DownloaderPort;
  converter: AudioConverterPort;
  transcriber: TranscriberPort;
  summarizer: SummarizerPort;
}
