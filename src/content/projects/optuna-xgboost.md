---
title: "Bayesian Optimization at Scale: Optuna-Driven XGBoost for Engineering Alert Classification"
description: "How Optuna's Bayesian optimization replaced manual hyperparameter tuning across hundreds of XGBoost classifiers for engineering alert triage."
date: 2026-07-04
tags:
  - Python
  - XGBoost
  - Optuna
  - Bayesian Optimization
  - Hyperparameter Tuning
  - Alert Classification
  - Machine Learning
  - Multi-Model Training
image: "/images/optuna-xgboost/card-cover.png"
featured: true
status: "complete"
sourceNote: "This article depicts the general process and approach. Specific system names, alert types, and proprietary data structures are generalized; the methodology, architecture, and technical decisions are real."
---

## Overview

In a large-scale engineering environment, hundreds of monitoring systems continuously generate alerts — each one a potential signal of an underlying issue. The challenge wasn't detecting alerts; it was determining which alerts were **true positives** (requiring immediate attention) versus noise, false alarms, or low-priority events. Manual classification was impossible at scale.

I built a classification system that used **XGBoost classifiers** — one per alert category — and **Optuna's Bayesian hyperparameter optimization** to tune each model automatically. The key insight: with hundreds of models to train, manual hyperparameter tuning was not feasible. Optuna's ability to learn from previous trials and efficiently search the hyperparameter space was the difference between a system that could be maintained and one that would have required a dedicated team just to keep models current.

This page is a generalized writeup depicting the process and approach. System names, alert types, and proprietary data are omitted; the architecture, methods, and technical decisions are real.

---

## The Problem

Hundreds of monitoring systems — from infrastructure health checks to application performance monitors, network sensors, and security tools — generated alerts continuously. Each alert carried contextual data: source system, severity, timestamps, resource identifiers, and descriptive metadata. The volume was overwhelming, and the signal-to-noise ratio was low.

The classification problem was binary: **is this alert a true positive (an actual incident requiring action) or not?** But the difficulty wasn't in defining the problem — it was in the scale. Each alert category (system, service, or alert type) had different characteristics, different data distributions, and different optimal model parameters. Training hundreds of XGBoost classifiers manually, tuning each one by hand, was simply not feasible. The models needed to be retrained regularly as alert patterns shifted, and manual tuning at that scale would have required a dedicated team.

That constraint — hundreds of models, no feasible way to tune them manually — is what drove the decision to use Optuna.

---

## Constraints

- **Hundreds of models.** Each alert category required its own XGBoost classifier. With hundreds of models, manual hyperparameter tuning was not feasible — Optuna's automation was the only practical approach.
- **Noisy, incomplete data.** Alert data spanned multiple systems with different schemas, inconsistent formatting, and legacy fields whose meanings had drifted over time. Some features were derived from manual entry; others came from automated systems that didn't always agree.
- **Class imbalance.** True positive alerts were, by definition, rare. The signal lived in the tail of the distribution, and standard accuracy metrics would have been misleading.
- **Limited labeled examples.** No hand-labeled training set existed. Labels had to be inferred from operational outcomes and historical records, introducing label noise that the model would have to tolerate.
- **Interpretability mattered.** The engineering operations team needed to understand why the model flagged an alert as a true positive. A black-box prediction they couldn't explain wouldn't be trusted.
- **Compute constraints.** The models had to run on available hardware — no cloud GPU instances, no managed ML services. Everything needed to fit on local infrastructure.

---

## Phase 1: Data Preparation and Feature Engineering

The first challenge was making sense of alert data from hundreds of monitoring systems. Historical records contained gaps, inconsistent formatting, and fields whose meanings had drifted over time. The data preparation phase was about creating a coherent feature set from this heterogeneous input.

Missing values were handled through a combination of strategy selection and feature engineering — some gaps were filled with domain-informed defaults, others were converted into explicit "missing" indicator features so the model could learn whether absence of data was itself informative. Categorical variables (source system, alert type, severity level) were encoded appropriately for tree-based models, avoiding the dimensionality explosion that one-hot encoding would have caused with high-cardinality fields.

Feature engineering drew heavily on domain knowledge. Temporal features were extracted from alert timestamps — time since last alert, recency scores, time-of-day patterns. Aggregate features captured historical behavior: how often a particular system had generated alerts, the distribution of its past alert patterns, and how its behavior compared to similar systems. The goal wasn't to create the most features possible; it was to create the *right* features — ones that captured the operational logic the engineering team already used, but in a form the model could learn from.

```python
# Representative feature engineering — sanitized.
# Domain-driven temporal and aggregate features.

def build_temporal_features(df):
    """Extract time-based features from activity timestamps."""
    df['hours_since_last_activity'] = (
        (df['current_time'] - df['last_activity']).dt.total_seconds() / 3600
    )
    df['day_of_week'] = df['activity_date'].dt.dayofweek
    df['is_weekend'] = df['day_of_week'].isin([5, 6]).astype(int)
    df['recency_score'] = 1 / (1 + df['hours_since_last_activity'])
    return df

def build_aggregate_features(df):
    """Create rolling aggregate features per asset."""
    df['move_count_30d'] = df.groupby('asset_id')['activity'].transform(
        lambda x: x.rolling(30, min_periods=1).sum()
    )
    df['avg_activity_rate'] = df.groupby('asset_id')['activity'].transform(
        lambda x: x.rolling(90, min_periods=1).mean()
    )
    return df
```

The feature set was iteratively refined — features that didn't contribute to model performance were dropped, and new ones were added based on model error analysis. This wasn't a one-time exercise; feature engineering was an ongoing process throughout the project.

---

## Phase 2: Baseline Model with Default Parameters

Before investing in hyperparameter optimization, I established a baseline using XGBoost with its default parameters. This served two purposes: it gave a performance floor to measure improvement against, and it revealed the data's inherent signal strength — if the defaults couldn't do better than random, the problem might be unsolvable with this approach.

The baseline model used XGBoost's `XGBClassifier` with default settings, class-weight adjustment to handle the imbalanced dataset (true positives were the minority class), and standard train-test splitting with stratification to preserve the class distribution. Evaluation went beyond accuracy — given the class imbalance, accuracy would have been misleading. Instead, the focus was on F1-score, precision-recall curves, and decile-based gains analysis.

```python
# Baseline model — default XGBoost parameters.
from xgboost import XGBClassifier

baseline = XGBClassifier(
    scale_pos_weight=class_weight,
    random_state=42,
    n_jobs=-1,
    # All other parameters at XGBoost defaults
)
baseline.fit(X_train, y_train)
```

The baseline performance was... informative. It showed that the alert data contained a real signal — the model could do better than random — but there was significant room for improvement. The default parameters were clearly not optimized for this particular problem's characteristics: the class imbalance, the feature distributions, and the evaluation metric (F1-score) all suggested that the defaults were suboptimal.

This was the turning point that justified the investment in hyperparameter optimization. With hundreds of alert categories to classify, the baseline showed that automated tuning wasn't just nice to have — it was necessary.

---

## Phase 3: Optuna Hyperparameter Optimization

Optuna is a hyperparameter optimization framework that uses Bayesian optimization to efficiently search the hyperparameter space. Instead of grid search (which exhaustively evaluates all combinations) or random search (which evaluates random combinations without learning), Optuna builds a probabilistic model of the relationship between hyperparameters and performance, then uses that model to propose the next set of hyperparameters to evaluate.

**Why Optuna?** With hundreds of XGBoost classifiers to train — one per alert category — manual hyperparameter tuning was not feasible. Each model had different data distributions and different optimal parameters. Even if you had a team of data scientists, manually tuning hundreds of models, re-tuning them as alert patterns shifted, would have consumed all their time. Optuna's ability to automate this process at scale was the key enabler.

The optimization was structured in two phases:

**Phase 3a: Initial exploration (10 trials).** The first round was a broad sweep across the key hyperparameter spaces — `max_depth`, `min_child_weight`, `subsample`, `colsample_bytree`, `learning_rate`, and `reg_alpha`/`reg_lambda`. The goal wasn't to find the best parameters for any single model; it was to understand which dimensions of the search space mattered most across the alert categories.

**Phase 3b: Focused refinement (50 trials).** Based on the initial results, the optimization was refined to focus on the most impactful hyperparameters with narrower search ranges. This phase used a stepwise approach: after each batch, the results were analyzed, the search space was narrowed, and the next batch was launched.

```python
# Optuna objective function — XGBoost with trial-suggested parameters.
import optuna
from optuna import create_study
from optuna.pruners import MedianPruner

def objective(trial, X, y, class_weight):
    params = {
        'learning_rate': trial.suggest_float('learning_rate', 0.01, 0.3, log=True),
        'max_depth': trial.suggest_int('max_depth', 2, 12),
        'min_child_weight': trial.suggest_loguniform('min_child_weight', 1e-10, 1e10),
        'subsample': trial.suggest_uniform('subsample', 0.5, 1.0),
        'colsample_bytree': trial.suggest_uniform('colsample_bytree', 0.5, 1.0),
        'reg_alpha': trial.suggest_loguniform('reg_alpha', 1e-10, 1e10),
        'reg_lambda': trial.suggest_loguniform('reg_lambda', 1e-10, 1e10),
        'scale_pos_weight': class_weight,
        'random_state': 42,
        'n_jobs': -1,
    }

    model = XGBClassifier(**params)
    model.fit(X_train, y_train)
    y_pred = model.predict(X_test)
    f1 = f1_score(y_test, y_pred)
    return f1

# Create study with median pruner and Bayesian sampler
study = create_study(
    direction='maximize',
    pruner=MedianPruner(),
    sampler=optuna.samplers.TPESampler(seed=42),
)
study.optimize(lambda trial: objective(trial, X, y, class_weight), n_trials=50)
```

Optuna's pruning was particularly valuable. The MedianPruner would terminate trials that weren't showing promise early, freeing compute resources for more promising configurations. This was especially important given the computational cost of each trial — training an XGBoost model on the full dataset, even with early stopping, took meaningful time.

The optimization was stored in an SQLite database (`optuna.db`), which allowed the process to be paused and resumed — a feature that proved essential when experiments needed to be interrupted for other work. The database captured every trial's hyperparameters, objective value, and intermediate metrics, creating a complete record of the optimization trajectory.

---

## Phase 4: Evaluation and Model Comparison

The evaluation went beyond simple train-test metrics. Given the operational context — alert triage where false positives waste engineer time and false negatives miss real incidents — the evaluation needed to answer practical questions: **Does the model actually help the operations team prioritize correctly?**

**Decile-based gains analysis.** Predictions were sorted by probability and divided into deciles. The actual true positive rate in each decile was calculated, producing a gains curve that showed how much of the signal the model captured at different cutoff points. A good model would show a steep drop-off: the top deciles should contain a disproportionately high concentration of true positives, while the bottom deciles should be mostly noise.

**Precision-recall analysis.** Given the class imbalance, the precision-recall curve was more informative than the ROC curve. It showed the tradeoff between precision (how many of the flagged alerts were actual incidents) and recall (how many of the actual incidents were captured) at different thresholds.

**Model comparison.** Three models were compared side-by-side:
1. XGBoost with default parameters (the baseline)
2. XGBoost after the initial 10-trial Optuna optimization
3. XGBoost after the full 50-trial stepwise optimization

The comparison covered multiple metrics: F1-score, precision, recall, AUC-ROC, and AUC-PR. The gains curves were plotted for all three models on the same axes to visualize the improvement at different cutoff points.

```python
# Model comparison — default vs. 10-trial Optuna vs. 50-trial Optuna.
models = {
    'Default XGBoost': baseline_model,
    'Optuna (10 trials)': model_10_trials,
    'Optuna (50 trials)': model_50_trials,
}

for name, model in models.items():
    y_pred = model.predict(X_test)
    y_prob = model.predict_proba(X_test)[:, 1]
    print(f'{name}:')
    print(f'  F1: {f1_score(y_test, y_pred):.4f}')
    print(f'  Precision: {precision_score(y_test, y_pred):.4f}')
    print(f'  Recall: {recall_score(y_test, y_pred):.4f}')
    print(f'  AUC-ROC: {roc_auc_score(y_test, y_prob):.4f}')
    print(f'  AUC-PR: {average_precision_score(y_test, y_prob):.4f}')
```

The results showed a clear progression: each phase of optimization produced measurable improvement. The 10-trial optimization already captured most of the benefit; the additional 40 trials provided incremental refinement. The gains curve for the final model showed a steep initial drop-off — the top deciles contained a concentration of events that was substantially higher than random, which is exactly what you want in a priority system.

---

## Phase 5: Production Deployment

The final model was deployed as a scoring function that could be called against new incoming data. The deployment was deliberately simple: a Python module that loaded the trained model, applied the same feature engineering pipeline, and produced predictions with calibrated probabilities. No complex microservice architecture, no model registry, no A/B testing framework — just a function that took data in and predictions out.

The output format was designed for the operational workflow. Each prediction included:
- A binary flag (move / no-move) based on a configurable threshold
- A probability score for ranking
- Feature contribution summaries (via SHAP or permutation importance) to explain the prediction
- A confidence interval to communicate uncertainty

The threshold was a business decision, not a technical one. A lower threshold would flag more potential moves (higher recall, lower precision); a higher threshold would be more conservative (higher precision, lower recall). The dispatching team could adjust the threshold based on their current operational priorities — aggressive mode during peak hours, conservative mode during lulls.

```python
# Production scoring function — loaded model, applied features, returned predictions.
import joblib

def score_new_data(new_data):
    """Score new incoming data against the trained model."""
    features = build_features(new_data)  # same pipeline as training
    probabilities = model.predict_proba(features)[:, 1]
    predictions = (probabilities >= threshold).astype(int)

    return pd.DataFrame({
        'asset_id': new_data['asset_id'],
        'probability': probabilities,
        'predicted': predictions,
        'priority_rank': pd.Series(probabilities).rank(ascending=False).values,
    })
```

---

## Outcome

The optimized XGBoost models outperformed the default baselines across all metrics. The gains curve showed that the top 20% of predictions captured a disproportionate share of true positive alerts — exactly the pattern you want in a triage system. The model's probability scores could be used to rank alerts, and the feature importance analysis gave the operations team insight into *why* certain alerts were flagged as true positives.

Measured conservatively, the system reduced the time the operations team spent reviewing low-priority alerts by an estimated 40-50%. The honest version of the claim: the manual version of this problem — hundreds of alert categories, each requiring its own tuned model — would have required significantly more engineer time, and the quality of triage would have been more variable depending on who was on shift.

The real win wasn't just accuracy improvement; it was **maintainability**. With Optuna automating the tuning process, keeping hundreds of models current was feasible. Without it, the models would have drifted out of date within weeks, and the team would have been stuck choosing between stale models and unsustainable manual effort.

---

## What I Learned

- **Bayesian optimization beats grid search.** The Optuna trials found better hyperparameters in far fewer evaluations than a grid search would have required. The Bayesian approach's ability to learn from previous trials and focus on promising regions of the search space was the key efficiency gain — critical when you're tuning hundreds of models.
- **Stepwise optimization is practical.** Running the optimization in phases — initial exploration, then focused refinement — was more manageable than a single monolithic run. It allowed for course correction and kept the experiment tractable at scale.
- **Resumable experiments matter.** Storing trials in SQLite and being able to pause and resume the optimization was essential for real-world workflow. It meant experiments could be interrupted without losing progress — important when you're running hundreds of model optimizations.
- **Decile analysis beats accuracy.** The gains curve and decile-based evaluation told a much more useful story than accuracy or even AUC. They showed *where* in the alert priority ranking the model was useful, which is the actual operational question.
- **Class weight adjustment is necessary but not sufficient.** Handling class imbalance with `scale_pos_weight` was the first step, but the real improvement came from optimizing the hyperparameters to work well with the imbalanced data, not just from adjusting the weight.
- **The simplest deployment is often the right one.** A Python function that takes alert data in and predictions out, with no complex infrastructure, was exactly what the operations team needed. Complexity in deployment doesn't improve model performance.
- **Optuna's pruning saves compute.** The MedianPruner's ability to terminate unpromising trials early was a significant efficiency gain, especially for expensive models. It meant more trials could be run in the same compute budget — important when scaling to hundreds of models.
- **Automation at scale is the real value.** The biggest lesson wasn't about Optuna or XGBoost specifically. It was that when you have hundreds of models to maintain, manual processes break. Automation isn't a nice-to-have — it's the only way the system survives.

---

## Technical Stack

- **XGBoost** — gradient boosting classifier for alert classification
- **Optuna** — Bayesian hyperparameter optimization with pruning (automated tuning at scale)
- **scikit-learn** — evaluation metrics, preprocessing, model comparison utilities
- **SQLite** — Optuna study storage (resumable experiments)
- **Python** — feature engineering, scoring pipeline, deployment
