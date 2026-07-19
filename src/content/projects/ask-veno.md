---
title: "Ask Veno: A Fully Local YouTube RAG Pipeline with a Retro-Terminal Dashboard"
description: "Turning 257 YouTube livestreams into a searchable, source-anchored knowledge base — Whisper, ChromaDB, and Ollama running entirely on local hardware."
date: 2026-07-08
tags:
  - Python
  - RAG
  - FastAPI
  - ChromaDB
  - Whisper
  - Ollama
  - Local LLM
  - Embeddings
  - yt-dlp
  - SQLite
image: "/images/ask-veno/ask-veno.png"
github: "https://github.com/cbroker1/ask-veno"
featured: true
status: "complete"
sourceNote: "Personal project — source and screenshots on GitHub. Everything described here runs locally: no cloud APIs, no paid services."
---

![The Ask Veno dashboard in its S.T.A.L.K.E.R. GAMMA PDA theme: amber phosphor text on a dark CRT-style background with scanlines, circular pipeline-status dials, a scan-style search bar, and the video archive table listing ingested streams](/images/ask-veno/ui.png)

## Overview

Ask Veno is a fully offline retrieval-augmented generation (RAG) system that turns a YouTube channel into a searchable knowledge base. It ingests an entire channel's livestream archive — audio download, Whisper transcription, chunking, embedding — and serves it through a single-file FastAPI dashboard styled as a S.T.A.L.K.E.R. GAMMA PDA: amber phosphor glow, CRT scanlines, and all.

Ask any question about the channel's content and the system retrieves the most relevant transcript chunks from a ChromaDB vector store, generates a direct answer with a local LLM via Ollama, and returns source-anchored video links with timestamps — click a result and the video opens inline at the exact moment the answer came from.

The whole thing runs on my own hardware. No cloud APIs, no paid services, no data leaving the machine: **yt-dlp → faster-whisper → ChromaDB → Ollama**, orchestrated by a SQLite state machine. The current index covers **257 videos and 21,959 transcript chunks**, processed end to end with zero anomalies.

---

## The Problem

A YouTube channel I follow has hundreds of hours of livestreams — long, unstructured, and completely unsearchable. The knowledge in them is real (what happened in which playthrough, what settings were used, how a particular situation was handled), but the only way to find anything was to remember roughly which multi-hour stream it happened in and scrub through it.

YouTube's own search doesn't reach inside videos. Auto-generated captions exist but aren't queryable as a corpus. What I wanted was simple to state and annoying to build: **ask a question in plain language, get a direct answer, and jump to the exact timestamp in the exact video where that answer comes from.**

I also wanted the pipeline to be honest about its own scale. Hundreds of long videos means days of transcription compute, flaky network downloads, and a process that *will* be interrupted. A naive script that starts at video 1 and dies at video 83 wasn't going to cut it. The pipeline had to be resumable by design.

---

## Constraints

- **Fully local.** No cloud transcription, no hosted embeddings, no LLM APIs. The entire pipeline — download, transcription, embedding, retrieval, generation — had to run on hardware I own.
- **Long-running, interruptible work.** Transcribing hundreds of multi-hour streams takes days of GPU time. Every stage had to be pausable and resumable without losing or duplicating work.
- **Flaky inputs.** YouTube downloads fail, rate-limit, and occasionally demand fresh authentication. The pipeline needed to tolerate partial failures and pick up where it left off.
- **Mixed hardware budget.** One GPU (RTX A6000) worth reserving for the genuinely GPU-bound stage — Whisper. Everything else — embeddings, vector search, LLM inference, the web app — had to run acceptably on CPU (Ryzen 9 9950X).
- **Answers need receipts.** A summary alone is worthless for this use case. Every answer had to link back to specific videos at specific timestamps so the source is one click away.
- **Single-user simplicity.** This is a personal tool. No auth, no multi-tenancy, no deployment infrastructure — but it still had to feel polished enough that using it is a pleasure, not a chore.

---

## Phase 1: A SQLite State Machine for Ingestion

The foundation of the pipeline isn't a model — it's a SQLite registry. Every video discovered on the channel gets a row, and every processing stage is a status field on that row. Each stage of the pipeline is a queue processor: it queries for rows in the right state, processes a bounded batch, and advances the status.

Discovery uses yt-dlp's flat extraction for fast channel scans, filters videos by title substring (the channel mixes content types, and I only wanted a specific series), then enriches the matches with full metadata:

```python
# Discovery — scan the channel, match by title, persist candidates.
# yt-dlp extract_flat=True makes the channel scan fast; only matched
# videos get a full metadata fetch.

python scripts/discover_audio_candidates.py \
    --channel-url "https://www.youtube.com/@channel/streams" \
    --title-filters "ONE LIFE,1 LIFE"
```

Each downstream stage follows the same pattern — select by state, process, advance:

```
discovered → audio_ready → transcript_ready → transcript_clean_ready → complete
              (yt-dlp)     (faster-whisper)      (cleanup)             (ChromaDB)
```

Every processor defaults to handling **one video per invocation**, with flags to raise the batch size. That sounds conservative, but it's the point: a single `run_pipeline_once.py` pass advances every queue by a small amount, can be killed at any time, and a cron-driven daily job keeps the index current as new streams are published. Nothing is ever half-done in a way the registry can't see — if a stage crashes mid-video, the status field never advanced, and the next run simply retries it.

---

## Phase 2: Whisper Transcription on the GPU

Transcription is the only stage that earns the GPU. The queue processor loads **faster-whisper large-v3** once, then works through queued audio files with batched inference (`float16`, batch size 8, beam size 5), voice-activity-detection filtering to skip silence, and `word_timestamps=True` for per-word timing.

The word-level timestamps are not a nice-to-have — they're the feature. Every downstream chunk keeps its start time, which is what makes "jump to the exact moment in the video" possible at the end of the pipeline.

```python
# Transcription queue — load the model once, drain the queue.
# word_timestamps=True is what makes timestamp deep-links possible later.

model = WhisperModel("large-v3", device="cuda:0", compute_type="float16")

for video in queued_videos:  # ingest_status='audio_ready'
    segments, info = model.transcribe(
        video.audio_path,
        word_timestamps=True,
        vad_filter=True,
        beam_size=5,
    )
    write_transcript_json(video, segments)
    mark_transcribed(video)  # whisper_status='transcribed'
```

Raw Whisper output is verbose — tokens, probabilities, segment internals. A separate cleanup stage strips each transcript down to what retrieval actually needs: `start`, `end`, `text` per segment. Keeping cleanup as its own queue stage (rather than folding it into transcription) meant I could re-run it across the whole corpus when I changed the cleaning rules, without re-transcribing anything.

---

## Phase 3: Chunking and Embedding into ChromaDB

Cleaned transcripts are chunked by **tokenizer token count** — 512 tokens per chunk with 25% overlap — not by characters or sentences. Chunking in the embedding model's own token space means every chunk actually fits the model's context window, and the overlap keeps answers that span a chunk boundary retrievable from either side.

Each chunk records the timestamp of its first segment and pre-computes a `youtube_time_url` — the video URL with `&t=<seconds>` baked in. The deep-link is stored as metadata at index time, so the query path never has to reconstruct it.

Embeddings come from **intfloat/multilingual-e5-large**, running on CPU. E5 models expect asymmetric prefixes — `passage:` for indexed text, `query:` for searches — and getting this detail right measurably improves retrieval:

```python
# Embedding queue — chunk in token space, embed with E5 passage prefix,
# store with timestamp metadata for deep-linking.

chunks = chunk_by_tokens(transcript, max_tokens=512, overlap=0.25)

embeddings = embed_model.encode(
    [f"passage: {c.text}" for c in chunks],
    batch_size=32,
)

collection.add(
    ids=[c.chunk_id for c in chunks],
    embeddings=embeddings,
    documents=[c.text for c in chunks],
    metadatas=[{
        "video_id": c.video_id,
        "title": c.video_title,
        "start_s": c.start_s,
        "youtube_time_url": f"{c.video_url}&t={int(c.start_s)}s",
    } for c in chunks],
)
```

ChromaDB persists to local disk, and embedding is — like every other stage — a resumable queue: a video only flips to `complete` once its chunks are committed to the collection.

---

## Phase 4: Retrieval and Local LLM Answers

The query path inverts the pipeline. A question is embedded with the E5 `query:` prefix, ChromaDB returns the top 5 chunks by similarity, and a local LLM turns them into a direct answer.

Generation runs on **qwen3:0.6b via Ollama, on CPU**. A 0.6B-parameter model sounds almost comically small, but the job here is narrow: synthesize five retrieved transcript chunks into a few sentences. Retrieval does the heavy lifting; the LLM is a summarizer, not an oracle. Keeping it small means answers come back in seconds on CPU while the GPU stays free.

One design decision that took iteration: **the LLM does not handle citations.** Early versions asked the model to cite its sources inline, and a small model does that badly — malformed links, wrong attributions. The fix was to remove the responsibility entirely. The model only writes the summary; the application renders the sources itself as a clickable list below it, built directly from the chunk metadata. The links can't be wrong because the model never touches them.

```python
# Query path — E5 query prefix, top-5 retrieval, local summarization.
# The LLM writes the answer; the app renders the sources. Never both.

emb = embed_model.encode(f"query: {question}")
res = collection.query(query_embeddings=[emb], n_results=5,
                       include=["documents", "metadatas", "distances"])

context = "\n\n".join(chunk.text for chunk in res)
summary = ollama_generate(
    model="qwen3:0.6b",
    prompt=f"Question: {question}\n\nSource chunks:\n{context}\n\nAnswer:",
)

return summary, [c.metadata["youtube_time_url"] for c in res]
```

If Ollama isn't running, the dashboard degrades gracefully: retrieval still works, results still render with their deep-links, and a status LED in the header flips from `SYNTH ONLINE` to `SYNTH OFFLINE`.

---

## Phase 5: The PDA Dashboard

The interface is a **single-file FastAPI application** — routes, templates, and styling in one `web_app.py`. For a single-user tool, one file beats a frontend build pipeline: no bundler, no node_modules, nothing to deploy but `python web_app.py`.

The design brief was a S.T.A.L.K.E.R. GAMMA PDA, because the best RAG interface for a corpus of Zone survival streams is one that feels like it survived the Zone:

- **Phosphor glow** — subtle `text-shadow` on text elements, mimicking CRT phosphor excitation
- **Scanlines** — a CSS gradient overlay on a pseudo-element, no images
- **Circular progress rings** — SVG stat dials showing pipeline completion at a glance
- **Inline playback** — clicking a result card expands an embedded player at the exact timestamp the chunk came from
- **A spinning ☢ loader** — because Ollama inference on CPU takes a few seconds, and the wait should be in character

The dashboard also doubles as the pipeline's monitoring surface: the video archive table shows every ingested stream with its status, chunk count, duration, and upload date, driven by the same SQLite registry the queue processors use. There is exactly one source of truth about pipeline state, and both the CLI tools and the UI read it.

---

## Outcome

The system does the thing: ask a question about 257 livestreams — roughly hundreds of hours of unstructured talk — and get a direct answer with clickable, timestamped sources in a few seconds, entirely offline. The full corpus (21,959 chunks) processed with zero anomalies in the registry, and a daily job keeps the index current as new streams are published.

The pipeline's resumability paid for itself many times over during the initial backfill. Downloads failed, authentication expired, the machine was needed for other work mid-run — and none of it mattered, because every interruption just meant running the pipeline again. The registry knew exactly what was done.

And honestly: the PDA theme is what makes it a tool I actually open. Utility gets a project used once; character gets it used daily.

---

## What I Learned

- **State machines beat scripts for long-running ingestion.** The SQLite registry — explicit per-stage statuses, bounded batches, idempotent processors — is the difference between a pipeline that survives interruption and one that has to be babysat. This pattern transfers to any multi-stage ingestion problem.
- **Small local models are enough when retrieval does the work.** qwen3:0.6b produces genuinely useful answers because it's never asked to know anything — only to summarize five well-retrieved chunks. Scoping the LLM's job narrowly is what made CPU inference viable.
- **Don't let the LLM touch structured output it can't reliably produce.** Moving citations out of the prompt and into application code eliminated an entire class of malformed-link failures. If the application can render something deterministically, the model shouldn't be generating it.
- **Chunk in token space, not character space.** Chunking by the embedding model's own tokenizer (512 tokens, 25% overlap) guarantees chunks fit the model and behave consistently across languages and vocabulary.
- **E5 prefixes matter.** `passage:` at index time, `query:` at search time — an easy detail to miss, and retrieval quality visibly suffers without it.
- **Timestamps are the product.** The direct answer is nice; the `&t=` deep-link into the source video is what makes the tool trustworthy. Carrying word-level timing from Whisper all the way through to chunk metadata was worth the plumbing.
- **Spend the GPU where it counts.** Reserving CUDA for Whisper and running embeddings and inference on CPU was the right split — transcription is the only stage where GPU time changes the outcome from "days" to "hours."

---

## Technical Stack

- **FastAPI + Jinja** — single-file dashboard (PDA theme, inline playback, pipeline stats)
- **ChromaDB** — persistent local vector store (21,959 chunks across 257 videos)
- **intfloat/multilingual-e5-large** — embeddings, CPU
- **Ollama (qwen3:0.6b)** — local answer generation, CPU
- **faster-whisper (large-v3)** — batched GPU transcription with word timestamps
- **yt-dlp** — channel discovery and audio extraction
- **SQLite** — pipeline state registry driving every queue stage
- **Hardware** — NVIDIA RTX A6000 (transcription), AMD Ryzen 9 9950X (everything else)
