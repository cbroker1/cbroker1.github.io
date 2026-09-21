---
title: "Teaching a Decision Model to Fly U.N. Squadron from Raw SNES Memory"
description: "Decoding a 1991 shooter's object table, freezing the emulator while the model thinks, and the request redesign that took median decision confidence from 0.27 to 0.85."
date: 2026-09-21
tags:
  - LLM Agents
  - Game AI
  - SNES
  - Reverse Engineering
  - BizHawk
  - Prompt Design
  - Benchmarking
featured: false
draft: false
---

![Pixel title card reading "JEV plays U.N. SQUADRON", then gameplay from run R99 with the model's decision shown under each frame, ending on a GAME OVER card: 82 of 108 units, 1,015 decisions, 0 boss parts destroyed](/images/jev-un-squadron/hero.gif)

U.N. Squadron is a 1991 Capcom shooter for the Super Nintendo. You fly a jet left to right across a scrolling level, shooting helicopters, tanks and turrets, and at the end you fight a boss. I wanted to find out whether a language model could play it. I didn't want to use screen pixels or a trained policy. The model would read the game's working memory and make each move as a plain-language decision.

The model is Jev, from TypeSafe, and it isn't a chat model. More on that below.

The code, the Lua bridge, the dashboard and every evidence report are on GitHub: [cbroker1/jev-un-squadron](https://github.com/cbroker1/jev-un-squadron).

After three days, Jev flies level 1 from takeoff to the boss. Its best run destroyed 82 of the 108 enemies it met. The boss is still alive: no part of it has ever been destroyed.

The most useful thing I learned came from reading the vendor's documentation properly, which I should have done on the first day:

> *"Jev is not a calculator. We strongly recommend implementing any mathematical logic in code."*

For most of the project I was handing the model about 1,600 characters of pixel distances and frame counts per option and asking it to weigh them. When I moved those comparisons into Python and split the one overloaded question into three small ones, median confidence went from 0.27 to 0.85 and requests got 83% smaller.

## What Jev is

![The TypeSafe AI logo](/images/jev-un-squadron/typesafe.webp)

Jev is TypeSafe's first "System One" model. The name comes from Daniel Kahneman's fast, intuitive mode of thinking. Like an LLM, Jev reads natural language. Unlike an LLM, it never writes any. Three things set it apart from the chat models I usually work with:

- **It's trained for calibration, not preference.** Chat models are post-trained with RLHF, which rewards answers people prefer. Reasoning models use RLVR, verifiable rewards, and are slower and more expensive. Jev takes a third path that TypeSafe calls RLCD: reinforcement learning for calibrated decisions. Across many answers, an option Jev rates at 0.8 should be right about 80% of the time. That makes its confidence something code can branch on, and the confidence floors later in this article depend on it. One of TypeSafe's cofounders co-invented RLHF, so this is a deliberate turn away from it.
- **Questions and answers are typed.** You define the answer space up front. A Choice picks one option from a list, a Score rates something against levels you describe, and a Noul gives the probability that a statement is true. Every answer comes back with probabilities and a confidence. There's no text to parse, and the answer can't fall outside your list.
- **It reads one state and answers many questions in parallel.** Jev takes in the state once and evaluates every question against it independently. Adding questions barely changes latency, and one question can't contaminate another's answer. The redesign later in this article relies on this.

Because it never generates text, the pricing is unusual: $0.042 per million input tokens, and output is free. My original requests were about 25 KB, roughly 6,000 tokens at four bytes of JSON per token. So R99's 1,015 decisions came to about 6 million tokens, or about 26 cents for a full level. The redesigned 4 KB request brings the same run down to about 4 cents. The whole project ran on the free tier, so I actually paid nothing. Even at list price, the heaviest session (about 5,700 requests) would have come to less than $1.50.

## The loop

BizHawk 2.11 runs the ROM on its Snes9x core. A Lua script writes the game's state out as JSON on every frame. A Python controller reads that state, asks Jev which way to move, and writes the answer to a file the Lua side injects as controller input. The gun fires on its own pulse, so Jev only decides movement.

Every run is bounded. It has a frame budget and a cap on paid requests, and the runner closes the emulator it opened. Before starting, it checks the ROM hash and checks save slot 1 against a pinned SHA-256. That check exists because an early stray save overwrote the canonical starting point, and I had to restore it from BizHawk's `.bak` file.

## Reading the object table

The game keeps its live objects in a table in work RAM: 64-byte records from `0x1000` to `0x1FC0`. Bytes 1–3 of each record hold a 24-bit address: the subroutine the CPU calls each frame to update that object. That address turned out to be a stable type tag.

| Routine | What it drives |
|---|---|
| `$02:B04A` | helicopters |
| `$04:F97F` | enemy bullets |
| `$02:9274`, `$02:90F0`, … | ground tanks (a family of routines as they animate) |
| `$02:93DD` | turrets, which drop a power-up |
| `$04:FABA` | the dropped power-up |
| `$04:FAD9` | the screen-clearing power-up |

Finding a candidate address was the easy part. Trusting one took much longer. My rule was that a slot was adopted only when two independent recordings agreed: the marked reference had to follow its object across the screen, vanish when the object died or left, and not carry over when the game reused the slot for something else. Most types took a day of captures and replays to clear that bar.

Coordinates had their own trap. The early decoder read the low bytes of a 24-bit position and ignored the high byte. A helicopter at X=271, just off the right edge, decoded as X=15, so every time a helicopter crossed pixel 256 a phantom appeared on the far left. Reading the high byte made the phantoms disappear.

The player's own coordinates and the flyable bounds, X 16–239 and Y 48–191, came from held-direction probes that made zero model calls. The controller never moves outside ground it has measured.

## Freezing time while the model thinks

The first live run made three requests, moved left twice, and then stopped because the player's X coordinate had gone outside the tested range. Responses took 473 ms and 269 ms, and the game kept running during both. By the time an answer arrived, it applied to a screen that no longer existed.

The fix was pause-and-step. When the controller wants a decision, Lua calls `client.pause()`. Python asks Jev, writes the answer, and Lua unpauses and applies it from the exact frame that was observed. A 5-second watchdog unpauses the game if Python dies. No game frames pass while the model thinks.

It's slow in wall-clock terms. R99, the best full-level run, made 1,015 decisions at a median of 325 ms each, so about 68 seconds of game time took almost 7 minutes to play. In game time, though, Jev reacts instantly, and a fair test needs that.

Pause-and-step also showed that every run had been starting damaged. Jev's first decision comes at frame 20663. With the gun off during the scripted opening, the first helicopter formation survived long enough to hit the jet at about frame 20583. Firing through the opening fixed that.

## Facts help, instructions hurt

Most of the gameplay gains came from measuring things instead of assuming them.

- **Shot geometry.** The gun fires straight along the jet's Y at exactly 11 px per frame, measured over 420 steps. The kill bands turned out to be lopsided. Aircraft die if the jet is anywhere from 8 px above to 17 px below them. Tanks die from 6 px above to 10 px below. The old symmetric band had credited shots from 8 px above a tank, and one run held that useless altitude for forty straight decisions.
- **Forecasts over snapshots.** At first each option described the present: closest threat, current gap, aim error. Every choice looked sensible on its own, and together they crept the jet into a corner. When I gave each option a 30-frame forecast of where it would leave the jet, over a 4×8 grid of the screen, kills roughly doubled.
- **Walls from evidence.** If a shot stops short with no explosion nearby, something solid is probably in the way. Two stops at the same level position count as a wall, keyed by the game's scroll counter, and the controller remembers it for the rest of the run. One stop could be an enemy the table doesn't classify yet.

The baselines show the policy is doing real work. A jet that sits still and fires kills 5 enemies before it dies. A Jev decision every 30 frames got 10. With the measurements added, 1,800-frame runs reached 42.

The measurements helped every time. The instructions didn't. My coding agents wrote five plain-language instructions into the prompt during development, each describing a reasonable priority, and every one of them cost kills and was reverted. The four that were logged left runs at 36, 41, 37 and 13 kills. My own corrections as the person who has played the game worked every time: turrets first, boss parts can be damaged, tanks are reachable with a small drop, hug the ground, hold the bottom left under the big missiles. But they were facts about the game, not advice on how to think.

One related lesson: a signal that fires on almost every option tells the model nothing. A terrain rule that refused firing lines wherever the map had no evidence refused about 30% of lines. That was most of the level at the time, and the run simply stopped attacking. The version that shipped was tuned against measured data to refuse 6.4%.

## Measuring a change

Unit tests don't catch gameplay regressions. The 115 offline tests check that the bridge survives torn reads, that input leases expire, and that observations decode. None of them tell you whether the jet survives longer. So every change gets a run and a label:

```
run_segment.py --change "what this run tests"   # recorded in the run's manifest
runs_table.py --last 12 --full-level-only       # units destroyed, share, damage, the change
benchmark.py --recent 3 --baseline 12           # per level segment, against the previous band
```

Several reasonable-looking changes were reverted because the benchmark said they lost kills.

Watching runs live is what the dashboard is for. It follows whichever run is active, draws the classified object table as a radar, and shows Jev's probabilities for each move next to a feed of recent decisions and a history of every run. It only reads files the runs already write, so it can't affect a run.

![The Jev Squadron dashboard during run R141: a status bar with frame, decision number, action, confidence and latency; a radar of the jet, an enemy aircraft, bullets, turrets and a clear-all power-up; Jev's probability bars for the attack question; a live feed of decisions tagged with what each move pursued; and the run history table](/images/jev-un-squadron/dashboard.webp)

## The number that was in every file

The project scored damage with a heuristic: a slot that tended to appear on the frame the jet got hit. When I went back over 20 runs carefully, it had missed 6 of 33 hit events.

The real health counter was byte 8 of the player's own record in the object table. It starts at 8, drops when the jet is hit, and reaches 0 when the run ends. The controller had exported that record on every frame since the first day, so the answer was in every saved run and had never been read. Re-scoring all 212 recorded runs took a small script:

```
R131   frame 20582  lost 1   during the firing prelude
       frame 20766  lost 7   at (194,187)   dead
```

At least eight runs logged as "one hit" had actually lost all 8 health. A single event can take 7 of the 8 at once.

With the real counter I could give the model a health posture (healthy, careful, fragile, critical) and whether it could afford a hit right now. That let me add my own guidance on risk: go for a power-up, or for the turrets that drop one, because a better weapon makes the rest of the level easier, but only when health allows.

## The redesign

The documentation, all 109 pages of which I saved locally to check against, disagreed with how I was asking Jev almost everywhere. It says to keep questions atomic. It says many questions can go in one call and run in parallel for almost no extra latency. It says a large irrelevant state hurts accuracy. And it says to do the math in code.

My legacy request broke all four rules. It asked one question per call that mixed dodging, aiming, positioning, power-ups, terrain and the boss. It sent 22–25 KB per call, most of that instructions plus five options carrying raw numbers.

The redesign, `categorical-v1`, moves every comparison into Python: eligibility, objective selection, gap comparisons, fallbacks. Jev gets three short questions in one call, for **attack**, **pickup** and **position**, and each option comes with a categorical verdict instead of a number. The code works out "this move improves your aim" and says that. It doesn't send "aim error 14 px".

![A live stretch of run R141. Left: the game. Right: the dashboard's radar of the decoded object table, the jet's box and gun line tracking the real jet. Below: Jev's three parallel answers for attack, pickup and position, each with probability bars and a confidence, and the move that was applied](/images/jev-un-squadron/what-jev-sees.gif)

I ran each design three times, interleaved, on the same 900-frame opening:

| | Request | Latency | Units destroyed | Median confidence |
|---|---:|---:|---:|---:|
| Legacy | 24.8 KB | 330 ms | 78% | **0.27** |
| categorical-v1 | 4.1 KB | 253 ms | 71% | **0.85** |

![Histograms of Jev's per-decision confidence. Legacy: most decisions between 0.1 and 0.35, median 0.27, 83% below 0.5. Categorical-v1: a large spike above 0.9, median 0.85, 31% below 0.5](/images/jev-un-squadron/confidence-ab.png)

The confidence shift matches what the documentation predicts. The legacy controller had been acting on answers the model itself rated around a coin flip, with 83% of them below the vendor's 0.5 uncertainty floor.

The units column is where it got complicated. The new design destroyed fewer enemies, and the decomposition wasn't the cause. The cause was a confidence floor I'd added: below 0.5, repeat the previous move instead of acting. It overrode 276 decisions across three runs, none of them for a measured reason. Changing the floor didn't behave simply either:

| Floor | Units | Runs survived | Fallbacks per run |
|---|---:|---:|---:|
| 0.5 | 71% | 3 / 3 | ~92 |
| 0.3 | 75% | 3 / 3 | ~33 |
| none | – | 2 / 5 | 0 |

With no floor, three of five runs died. At 0.5, too many good answers were thrown away. The documentation's own pattern is a threshold set by what a wrong answer costs, and that's what the code uses now: 0.20 for attack moves, where a miss wastes a shot; 0.30 for pickups; 0.45 for positioning, where a mistake costs health; and 0.90 when escaping a collision.

With those floors plus the health posture and per-enemy spacing, the next three runs destroyed 75%, 75% and 81% of the opening's units. That's level with legacy at a sixth of the request size, and the 81% run lost just 1 health. Three runs per side is a small sample, so the gameplay result is a tie until more replicates say otherwise. The confidence and size gains are not in doubt.

## Two negative results worth keeping

**The terrain can't be read from VRAM on this core.** I tried five ways to read the level's solid geometry from the background tilemaps. The best alignment out of about 900 configurations predicted recorded collisions 92% of the time. A null model that only knows "sky above, ground below" scores 93%. The tilemap adds nothing without the PPU's scroll registers, which Snes9x in BizHawk doesn't expose. The structure map stays as measured shot-stops only.

**A quoted number was stale.** A handoff note said the structure map covered 63 columns. The file itself held 34 cells across 17 columns. The 63 predated a fix that correctly deleted cells shots had later flown through, and it had been carried forward from memory instead of regenerated. Every number in this article was rechecked against the run files for that reason.

## Where it stands

| | Best result |
|---|---|
| Full level | R99: 82 of 108 units (76%), reached the boss, died there |
| Boss fight | mean survival from 184 to 382 frames; best single attempt 566 |
| Boss parts destroyed | 0 |
| Undamaged runs | one: R8, 1,800 frames, 40 of 54 units, never touched |

The goal I set was every unit destroyed with the jet untouched, and it hasn't been met. The boss has two missile types that the object table tells apart cleanly: the big straight ones turn in 4% of frames and the small ones in 92%. Survival in the fight doubled once the jet stayed off the hull and held the bottom left, but nothing has been killed.

The health re-scoring also turned up a puzzle. Every run since R124 is hit at frame 20582, before Jev's first decision. That makes an undamaged run impossible in the current setup. It wasn't always like this: R8 went 1,800 frames without a scratch, and R99 took its first hit at frame 21073. Something in the setup changed between them, and each run's manifest records the Lua and controller hashes and the decision interval, so the difference can be tracked down.

## What's next

**Find the prelude hit.** Diff the setups for R8 and R124, or hand control to Jev earlier. The save starts at frame 20183, so no new save state is needed.

**Count what should be there.** The spawns are deterministic. A per-column list of expected enemies would turn each miss into a specific positioning decision rather than bad luck.

**Map the boss's health.** The player's health was sitting in an exported field all along. The hull parts probably have a counter too, and the runs to search are already on disk.

**Finish the A/B.** `categorical-v1` isn't the default yet. More interleaved replicates, judged by `benchmark.py` and not by any single run, will settle whether the gameplay gain is real or the smaller, more confident requests are the whole win.

The controller, the Lua bridge, the dashboard, the measured maps and the per-slot evidence reports are all at [github.com/cbroker1/jev-un-squadron](https://github.com/cbroker1/jev-un-squadron). The README covers running it yourself, if you have the ROM.

The boss is still alive.
