---
title: "Large-Scale Document Intelligence Pipeline"
description: "End-to-end local OCR, NLP, and machine learning system for classifying 250,000+ scanned unclassified records."
date: 2026-07-04
tags:
  - Python
  - OCR
  - Tesseract
  - Document AI
  - NLP
  - scikit-learn
  - Logistic Regression
  - RoBERTa
  - PyTorch
  - Transfer Learning
  - Batch Inference
  - Human-in-the-Loop AI
image: "/images/document-intelligence-pipeline/card-cover.svg"
github: "https://github.com/cbroker1/document-intelligence-pipeline"
featured: true
status: "complete"
sourceNote: "Case study only — original source is not public due to confidentiality. Sanitized demo code may be published later if recoverable from old archives."
---

## Overview

In a previous federal data science role, I built an end-to-end document intelligence pipeline for a repository of 250,000+ scanned unclassified records. The system combined local OCR, OCR quality measurement, classical NLP with Logistic Regression, RoBERTa transfer learning, full-corpus batch inference, and a ranked human-in-the-loop review workflow — all running on local hardware, with no cloud services involved.

Every document was scored by 20 classifiers: 10 scikit-learn n-gram Logistic Regression models and 10 fine-tuned RoBERTa models, one of each per business-defined category. The output was a scored, sortable review queue that let administrators start with the documents most likely to matter, instead of reading through a quarter-million records front to back. The workflow then ran on a monthly cadence as new documents kept arriving.

This page is a sanitized case study. Category names, internal systems, and document details are generalized throughout; the architecture, methods, constraints, and numbers are real.

---

## The Problem

The repository held 250,000+ scanned records accumulated over decades — everything from typewritten pages digitized long ago to modern computer-generated PDFs. Scan quality, layout, and text legibility varied wildly. Many files carried semi-structured type codes in their filenames; a large share had nothing but an opaque record number.

The business needed each record classified into one of 10 business-defined document categories. A fully manual pass would have consumed an enormous amount of administrator time — the kind of project that quietly never finishes. The actual requirement wasn't "classify everything perfectly." It was: **help the reviewers find the documents that belong in each category, in priority order, without reading everything.**

That reframing — from automation to ranked triage — shaped every technical decision that followed.

---

## Constraints

- **Local-only processing.** The records were sensitive but unclassified; nothing could leave the building. No cloud OCR, no hosted models, no external APIs. Privacy-preserving, local AI or nothing.
- **Messy inputs.** Degraded scans, skewed typewritten pages, and pristine digital exports lived in the same corpus. Some PDFs carried a legacy embedded text layer of unknown quality; many needed fresh OCR.
- **Limited hardware.** Consumer-grade workstation, a GTX 1080 Ti 8 GB GPU for deep learning, and finite RAM that put a hard ceiling on feature-matrix sizes for classical models.
- **Weak labels.** No hand-labeled training set existed. Supervision had to be mined from filename conventions and a small metadata database maintained by the review team.
- **Confidentiality.** The work itself, and now this write-up, had to avoid exposing operational details. That constraint is why this case study speaks in generic category names.

---

## Phase 1: Local OCR and OCR Quality Measurement

The pipeline started by OCR'ing the first five pages of every document locally with Tesseract. Five pages was a deliberate scope decision: opening pages carry most of a document's identifying language, and OCR'ing full documents across the corpus would have multiplied an already month-long compute job.

Before committing to the full run, I benchmarked DPI settings against three costs: recognition quality, processing time per page, and output size. Higher render resolution helped degraded scans but inflated processing time and disk usage across a quarter-million documents — this was a classic throughput-versus-quality tradeoff, and it had to be settled with measurements, not instinct. Even with tuned settings, OCR extraction and experimentation consumed **over a month of local batch compute**.

Because scan quality varied so much, I didn't treat OCR as a black box. Tesseract reports a confidence value for every recognized word, so I aggregated those into a document-level OCR confidence score and kept it as a first-class field in the dataset. Documents whose OCR pass failed outright were tracked with a sentinel value and re-queued instead of silently dropped.

```python
# Representative pseudocode — sanitized for public sharing.
# Tesseract emits a confidence value per recognized word;
# averaging them per document gives a usable quality signal.

def document_ocr_confidence(word_results):
    confidences = [w.conf for w in word_results if w.conf != -1]
    if not confidences:
        return None  # nothing usable — flag for re-OCR
    return sum(confidences) / len(confidences)

for document in document_batch:
    words = run_local_ocr(document.path, max_pages=5, dpi=selected_dpi)
    ocr_scores.append({
        "document_id": document.safe_id,
        "ocr_confidence": document_ocr_confidence(words),
    })
```

![Histogram of document-level OCR confidence across the corpus, with a long tail of degraded scans and a sharp peak of clean modern documents](/images/document-intelligence-pipeline/ocr-confidence-distribution.svg)

*OCR confidence across the corpus. Most documents OCR'd well, with clean modern scans forming a sharp peak — but the long tail of degraded and typewritten scans is exactly the subset where downstream model scores needed more skepticism. Figure recreated with representative synthetic data.*

That distribution became a data quality lens for the whole project. A model score on a 94%-confidence document and the same score on a 55%-confidence document do not mean the same thing — the second one is a prediction made on partially garbled text. Slicing OCR quality by predicted category later confirmed the intuition: categories dominated by older typewritten material sat visibly lower.

![Small-multiple histograms showing OCR confidence distributions for three predicted categories, with progressively heavier low-quality tails](/images/document-intelligence-pipeline/ocr-quality-by-category.svg)

*OCR quality sliced by predicted category. Some document types are mostly modern and OCR cleanly; others skew old and degraded. Figure recreated with representative synthetic data and generic category labels.*

One more wrinkle from the messy-data file: many PDFs already contained an embedded text layer from whenever they were first digitized. Rather than pick a winner, I kept both text streams — the legacy layer and my fresh Tesseract output — normalized the whitespace, and fed models the combination, so weak text in one stream could be rescued by the other.

---

## Phase 2: Classical NLP with Logistic Regression

With text extracted, the first modeling pass was deliberately classical supervised text classification: **10 binary scikit-learn Logistic Regression classifiers, one per business category**, over 1–3-gram count vectors with English stop words removed.

The training labels were the interesting engineering problem. No labeled dataset existed, so I mined the filename conventions — decades of humans encoding document types into filenames, complete with typos and drift — into weak labels, wrote normalization rules for the misspelled variants, and cross-referenced one category against a metadata database the review team maintained. Documents whose filenames were bare record numbers carried no usable signal; they became the unlabeled deployment set the models would later score. For each category I also trained two labeling variants — a broad one (type code appears anywhere in the filename) and a strict one (filename types the document as exactly that code) — and compared them to understand how label noise moved the results.

Practical constraints showed up immediately:

- **RAM-aware feature engineering.** A 1–3-gram vocabulary over a document corpus explodes quickly. N-gram ranges and vectorizer settings were tuned as much around available memory as around accuracy, and long-running cells aggressively freed intermediate objects to keep the workstation alive.
- **Class imbalance.** Every category was a minority against the rest of the corpus, handled with random oversampling of the minority class (imbalanced-learn), with the sampling strategy tuned per category.
- **Per-category hyperparameters.** Regularization strength (`C`, L1 penalty, liblinear solver) was tuned per model with randomized search over a log-scale grid.

```python
# Representative training pass for one of the ten categories — sanitized.
from sklearn.feature_extraction.text import CountVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split

X_train, X_test, y_train, y_test = train_test_split(
    document_texts, category_labels, test_size=0.1, random_state=42
)

vectorizer = CountVectorizer(ngram_range=(1, 3), stop_words="english")
X_train = vectorizer.fit_transform(X_train)
X_test = vectorizer.transform(X_test)

model = LogisticRegression(
    C=tuned_c_for_this_category, penalty="l1",
    solver="liblinear", max_iter=1000,
)
model.fit(X_train, y_train)
```

Evaluation used held-out splits with accuracy, precision, recall, F1, and ROC AUC per category. Held-out accuracy across the model family landed between roughly 98% and 100%. A representative category classifier:

| Metric (held-out test set) | Representative category model |
|---|---|
| Accuracy | 99.2% |
| Precision | 0.99 |
| Recall | 0.99 |
| F1 score | 0.99 |
| ROC AUC | 0.999 |
| Test documents | 10,871 |

*Values are taken directly from the original evaluation outputs for one of the ten categories; the category name is withheld.*

![ROC curve for a representative category classifier hugging the top-left corner, area under the curve approximately 0.999](/images/document-intelligence-pipeline/roc-representative-classifier.svg)

*ROC curve for the same representative classifier. Recreated from the original evaluation's AUC; class name generalized.*

The metrics deserve honest framing: with labels derived from filename metadata, a strong classifier partly re-learns the filename convention from the document text. That was acceptable — the goal was to project that convention onto the hundreds of thousands of documents whose filenames said nothing. Interpretability was the other reason to start classical: when a Logistic Regression model fires, you can read the n-grams that drove it.

---

## Phase 3: RoBERTa Transfer Learning

The second modeling pass built **10 RoBERTa-based classifiers via transfer learning** — starting from a publicly available pre-trained RoBERTa-large checkpoint, replacing the head with a dropout + linear classification layer, and fine-tuning end-to-end with PyTorch on the same weak labels.

Transformers made the hardware constraints personal:

- **Sequence length.** RoBERTa's architecture caps input at 512 tokens, but on an 8 GB GPU the practical training length was 250 tokens with batch size 12 — found by trial and error against out-of-memory errors. That made *which* text reaches the model the highest-leverage choice, and it's why the extraction focused on the highest-value window of each document: the opening pages where identifying language lives.
- **Training time.** A representative category's training pool was ~65,000 documents with an 80/20 class imbalance, split 90/5/5 into train/validation/test. Configurations that exceeded GPU memory had to fall back to CPU, where a single epoch took ~35 hours — the kind of number that forces you to plan experiments instead of casually re-running them.
- **Optimization details.** AdamW at a low learning rate (1e-6) with weight decay, linear warmup scheduling, and gradient clipping — standard fine-tuning hygiene, tuned to the small-batch regime the hardware imposed.

```python
# Representative fine-tuning setup — sanitized.
class CategoryClassifier(nn.Module):
    def __init__(self, n_classes):
        super().__init__()
        self.roberta = RobertaModel.from_pretrained(BASE_CHECKPOINT)
        self.drop = nn.Dropout(p=0.1)
        self.out = nn.Linear(self.roberta.config.hidden_size, n_classes)

    def forward(self, input_ids, attention_mask):
        _, pooled = self.roberta(input_ids=input_ids, attention_mask=attention_mask)
        return self.out(self.drop(pooled))

encoding = tokenizer.encode_plus(
    document_text,
    max_length=250,   # GPU-memory ceiling; the full 512-token window didn't fit
    truncation=True,
    padding="max_length",
    return_attention_mask=True,
    return_tensors="pt",
)
```

Fine-tuning reached ~96% validation accuracy on the representative category after the first epoch. The transformers read semantics rather than surface n-grams, which made them a genuinely different signal from the Logistic Regression models — and that disagreement between the two model families was itself useful review information. Where both fired, confidence was high; where they split, a human should look first.

---

## Phase 4: Full-Corpus Scoring and Batch Inference

Every document in the corpus was then scored across **all 20 classifiers** — batch inference across 250,000+ records, run locally. The Logistic Regression models were fast: roughly 200 documents per second per model, a full corpus pass in well under an hour per classifier. The output per document:

- a binary predicted flag per category,
- a calibrated-ish probability score per category (raw `predict_proba` outputs),
- the document-level OCR confidence from Phase 1,
- and document metadata for the reviewers.

Documents whose filenames already carried a type code were marked as *known from metadata* rather than given a model score, so reviewers could always tell discovery apart from confirmation. For the roughly 45,000 documents where no classifier fired at all, the system fell back to each document's maximum cross-model probability, so even the "no prediction" pile came ranked instead of alphabetized.

![U-shaped log-scale histogram of classifier probability scores across the corpus: most documents confidently scored near zero, a clear cluster near one, and few in between](/images/document-intelligence-pipeline/probability-distribution.svg)

*Full-corpus probability scores for one classifier (log scale). The distribution is what you want to see in a triage system: decisive mass at both ends, few ambiguous middles. The right-hand cluster is the review queue. Figure recreated with representative synthetic data.*

The delivery format was deliberately boring: a spreadsheet. Administrators already lived in spreadsheets, so the review queue was a sortable, filterable sheet where every row was a document — including a formula column that turned each document's location into a clickable link. No new tool to learn, no dashboard to maintain.

| document_id | ocr_confidence | category_a_probability | category_b_probability | review_priority |
|---|---|---|---|---|
| DOC-018204 | 93.8 | 0.994 | 0.011 | 1 |
| DOC-104551 | 91.2 | 0.972 | 0.038 | 2 |
| DOC-076318 | 88.5 | 0.941 | 0.007 | 3 |
| DOC-129077 | 61.4 | 0.887 | 0.052 | 4 |
| DOC-055930 | 94.1 | 0.312 | 0.296 | — |

*Illustrative mock-up of the review queue — synthetic IDs and values. Row four is the OCR-confidence signal earning its keep: a high model score on low-quality text gets flagged for more careful review rather than trusted outright.*

```python
# Representative scoring loop — sanitized.
for document in document_batch:
    text, ocr_confidence = load_extracted_text(document.safe_id)

    classifier_outputs = {}
    for category_name, model in category_models.items():
        probability = model.predict_proba([text])[0, 1]
        classifier_outputs[category_name] = probability

    review_queue.append({
        "document_id": document.safe_id,
        "ocr_confidence": ocr_confidence,
        "model_scores": classifier_outputs,
        "review_priority": review_priority(classifier_outputs, ocr_confidence),
    })
```

With two model families per category plus an OCR quality signal, the queue behaved like an ensemble-style review signal — not a formal ensemble with learned weights, but multiple independent signals presented side by side so a human could weigh them.

---

## Phase 5: Human-in-the-Loop Review

The system never made final determinations. Administrators did.

What the models changed was the shape of the work. Instead of an undifferentiated pile of 250,000 records, reviewers got a queue sorted by confidence: start at the top, where nearly everything is a hit; stop when the hit rate falls off; treat low-OCR-confidence rows with extra care. The models reduced the search space; the humans supplied the judgment. Confidence-based triage also gave the review effort a natural budget knob — a probability threshold — instead of an all-or-nothing automation decision.

I'd argue this was the single most important design decision in the project. A fully automated classifier at 99% accuracy still silently misfiles thousands of documents in a corpus this size, and nobody finds out until it matters. A ranking system at the same accuracy just puts a few oddballs slightly down-queue, where a human catches them. For decision support on messy real-world data, ranked review beat black-box automation on every axis that mattered here.

---

## Phase 6: Monthly Monitoring and Incremental Processing

The repository was alive — new records kept arriving after the initial corpus was processed. So the pipeline became an operational workflow rather than a one-time experiment.

On a monthly cadence, I snapshotted the repository index, diffed it against the previous month, and pushed anything new through the same machinery: OCR (or re-OCR for documents whose original text layer was unusable), scoring across all 20 models, and insertion into the review pool. The re-OCR path rendered each page image at high resolution, ran Tesseract per page, and merged the results back into a searchable PDF — replacing dead scans with documents you could actually search, at roughly 40 seconds per document for full-length records.

```python
# Representative monthly intake pass — sanitized.
current_snapshot = snapshot_repository_index()
known_documents = load_previous_snapshot()

new_documents = [d for d in current_snapshot if d.safe_id not in known_documents]

for document in new_documents:
    ensure_searchable_text(document)     # OCR or re-OCR as needed
    score_against_all_models(document)   # all 20 classifiers
    add_to_review_pool(document)

save_snapshot(current_snapshot)
```

![Loop diagram of the monthly cycle: repository snapshot, new document detection, OCR or re-OCR, model scoring, review pool update, repeating monthly](/images/document-intelligence-pipeline/monthly-monitoring-flow.svg)

*The recurring monthly intake loop — incremental batch processing rather than a one-off analysis.*

This is the unglamorous half of applied ML that rarely makes it into portfolios: recurring document intake, idempotent re-processing, corpus monitoring, and keeping a review pool current month after month.

---

## Outcome

![Flow diagram of the full pipeline: scanned records through local OCR and an OCR quality signal into ten Logistic Regression and ten RoBERTa classifiers, then batch inference, a scored review queue, and human review](/images/document-intelligence-pipeline/pipeline-diagram.svg)

*The full system, end to end.*

The pipeline converted a practically impossible manual review problem into a ranked triage workflow:

- **250,000+ records** OCR'd, quality-scored, and classified locally under privacy constraints.
- **20 trained classifiers** (10 Logistic Regression, 10 RoBERTa) with per-category evaluation — representative held-out results of 99%+ accuracy and ~0.999 ROC AUC.
- **A review queue administrators actually used**, combining predicted flags, model probabilities, OCR confidence, and one-click access to each document.
- **An operational monthly workflow**, not a notebook that ran once.

Measured conservatively — reading a quarter-million documents at even a few minutes each — prioritized review of this corpus likely saved **tens of thousands of administrator hours** compared with a fully manual classification pass. The honest version of the claim: the manual version of this project would simply never have been completed.

---

## What I Learned

- **OCR quality is model quality.** Downstream scores inherit upstream noise; measuring OCR confidence per document and carrying it through to the review queue was worth more than any single modeling improvement.
- **Classical ML still earns its place.** N-gram Logistic Regression was fast to train, cheap to run at corpus scale, interpretable when questioned, and nearly as accurate as the transformers on this task. Starting classical made the deep learning pass a comparison, not a leap of faith.
- **Transformers are powerful and expensive.** Transfer learning delivered semantic understanding the n-gram models couldn't match, but the 512-token window, GPU memory, and 35-hour CPU epochs made every experiment a budgeting exercise. Constraints force better engineering decisions.
- **Probabilities beat labels.** Nearly all of the system's operational value came from ranking by model confidence, not from the binary flags. Triage is a more robust product than automation.
- **Human-in-the-loop is a feature, not a compromise.** Keeping administrators as the decision-makers made a 99%-accurate system safe to deploy on a quarter-million records.
- **A spreadsheet can be the right product.** The most sophisticated part of the stack delivered its value through the least sophisticated interface its users already trusted.
- **Applied ML is workflow engineering.** Training models was maybe a fifth of the work. Extraction, quality measurement, labeling strategy, batch inference, review design, and monthly operations were the rest — and they're what made the models matter.

---

## Confidentiality Note

This case study is intentionally generalized to avoid disclosing sensitive operational details, document contents, category names, internal workflows, or agency-specific systems. Figures are recreated from the original analyses with synthetic, shape-representative data and generic labels; code snippets are representative pseudocode rather than production source. The focus is on the architecture, methods, constraints, and applied machine learning lessons rather than the underlying records themselves.

Faithful, sanitized versions of the project notebooks — same structure and methods, with outputs stripped and all identifiers generalized — are published in the companion repository: [github.com/cbroker1/document-intelligence-pipeline](https://github.com/cbroker1/document-intelligence-pipeline).
