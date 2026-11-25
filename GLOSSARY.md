# Summarize YT

Self-hosted YouTube-to-study-note workstation: paste one video URL, a worker downloads, converts, transcribes and summarizes it into a structured Markdown note.
_Avoid_: None — this is the project's own name for its single context.

## Language

**Job**:
A request to turn one YouTube video into one study note in one output language. A retried job is still the same job.
_Avoid_: Task, entry, request

**Stage**:
One of the four pipeline steps a job passes through: `downloading`, `converting`, `transcribing`, `summarizing`.
_Avoid_: Phase, step, activity

**Output language**:
The two-letter ISO 639-1 code (`lang`) choosing the note's language. The same video in a different language is a different job, not a reopening of the old one.
_Avoid_: Locale, translation, target

**Dedup**:
Reuse of an existing job for the same video plus the same output language instead of creating a second job. Only `queued`, `running` and `done` jobs count; `failed` ones are never reused.
_Avoid_: Duplicate detection, caching

**Artifact**:
The durable state of a job on disk, under one directory per job: downloaded `audio.<ext>`, converted `audio.wav`, per-chunk transcripts in `chunks/`, `transcript.txt`, `summary.md`, plus the sidecars `.title` and `stage.log`. Artifacts of a completed stage survive failure so a retry never pays twice.
_Avoid_: Output, file, temp file

**Resume point**:
The furthest valid artifact a re-queued job restarts from: valid `transcript.txt` skips to summarizing, valid `audio.wav` to transcribing, usable downloaded audio to converting.
_Avoid_: Checkpoint, restart point, retry offset

**History**:
The list of a job's finished study notes, newest first, searchable by title. Only `done` jobs appear; a history entry opens the stored study note without re-running the pipeline.
_Avoid_: Archive, log

**Study note**:
The Markdown deliverable a done job produces: TL;DR, learnings, concepts, details, and at most three actions — always shorter than the transcript.
_Avoid_: Summary, note, output
