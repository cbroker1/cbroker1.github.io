---
title: "Fifteen GPUs, One 320B Model: Does Every Card Earn Its Power?"
description: "Splitting GLM-5.3-Flash across 15 mismatched GPUs over 1 GbE: the model's own draft head bought 1.41x tokens per joule, a 5.7% single-GPU kernel win vanished on the fleet, and most GPU energy went to waiting."
date: 2026-11-05
tags:
  - LLM Serving
  - Distributed Inference
  - Energy Efficiency
  - llama.cpp
  - CUDA
  - Speculative Decoding
  - Benchmarking
featured: false
draft: false
---

![Diagram of four machines and 15 GPUs on 1 GbE. Every hop goes through the hub, GPURIG, which runs the llama.cpp server. A token visits, in order: 1, the Z13 tablet's Radeon 8060S (Strix Halo, 96 GB assigned, ROCm), blocks 0 to 19, 89.3 GiB, 41 percent of 218.0 GiB; 2, the rig's 11 cards of 8 GB on x1 risers, 7 NVIDIA on CUDA and 4 AMD on Vulkan, blocks 20 to 31, 61.2 GiB, 28 percent; 3, gamingrig's RTX 2080 Ti 11 GB and 4090 24 GB (CUDA), blocks 32 to 36, 25.5 GiB, 12 percent; 4, GPURIG's RTX A6000 48 GB (CUDA), blocks 37 to 44 and the output head, 42.0 GiB, 19 percent. The draft head is left out: it adds 3.3 GiB to the A6000 and 1.8 GiB to an RX 6600. The file, 223.8 GiB, also holds the draft head and 0.6 GiB kept in GPURIG's RAM.](/images/fifteen-gpus-one-model/fleet.svg)

Fifteen of my GPUs, in four machines, went into this project. My workstation has an RTX A6000. The PC I game on has an RTX 4090 and an RTX 2080 Ti, and a ROG Flow Z13 tablet has a Radeon 8060S built in. The other eleven sit on risers on a former mining board, seven NVIDIA cards and four AMD.

I intend to sell some of the older cards, and before I do I wanted a record of what all fifteen can do together. The question was how many useful output tokens a pile of mismatched GPUs produces per joule, and whether every card earns its power. The ambition was one large model served by every GPU at once.

The model is GLM-5.3-Flash, a 320B mixture-of-experts model with 18B parameters active per token. At UD-Q5_K_XL it is a 223.8 GiB file, more than any one of my machines can hold in memory. In September I [pooled two of these machines over Thunderbolt](/writing/thunderbolt-llm-cluster) for a 177B model. This time it was all fifteen GPUs.

It worked.

My first fifteen-GPU numbers looked plausible, and the text was garbage. The first valid baseline made 0.0090 output tokens per joule of GPU energy. The biggest lever was the model's own draft head: 1.41x the tokens per joule of a matched plain run. A CUDA kernel campaign found a real 5.7% gain on one card, and on the fleet it vanished. Most of the GPU energy pays for cards waiting their turn.

## Fifteen cards in four machines share one hub

GPURIG, my workstation, runs `llama-server`, which makes it the hub. The rig is the old mining board: a two-core i3, three power supplies and a PCIe x1 riser for every card.

The rig's seven NVIDIA cards run CUDA: two RTX 3070s, two RTX 3060 Tis, an RTX 2080, a GTX 1080 and a GTX 1070. Its four AMD cards, an RX 5700 XT and three RX 6600s, run Vulkan.

The PC I game on, gamingrig, runs its two cards through CUDA in WSL2, and the Z13's Radeon 8060S runs ROCm, also in WSL2. llama.cpp's RPC backend ties them together. Each of the other three machines runs an RPC server, and `llama-server` treats every GPU but the A6000 as a remote device.

The model splits by layer. The Z13 holds blocks 0–19, 41% of the weights; the rig holds 20–31 (28%), gamingrig 32–36 (12%) and the A6000 37–44 plus the output head (19%). A token visits the machines in that order.

Every machine reaches GPURIG over 1 GbE, with SSH tunnels into WSL2 for gamingrig and the Z13. Every hop between machines goes through GPURIG, and so does every handoff between the rig's CUDA and Vulkan cards.

## The rules came before the results

Every result below was measured inside limits set before it, and on November 2 I froze the scope:

- **One model.** huihui-ai's abliterated (uncensored) GLM-5.3-Flash at UD-Q5_K_XL. No other model or quantization.
- **All fifteen GPUs in every fleet run.** Every card at once was the point, so no run on this model compared subsets of the cards.
- **One request at a time.** Eight fixed chat prompts, greedy, at low reasoning effort, up to 384 output tokens each. Serving several requests at once was out of scope.
- **Default clocks and power management.** No clocks were locked or raised, and no power limits changed. I changed gamingrig's Windows power settings, and it stayed on the Balanced plan, with sleep off. The Z13 kept the ASUS Turbo and Windows "Best performance" modes it already ran in.
- **The network as it is.** Every machine is on 1 GbE. A network wall would have been an acceptable finding.
- **One engine.** llama.cpp b11960. Kernel changes stay local patches, and nothing goes upstream.
- **GPU energy only.** NVML board energy on the NVIDIA cards, the amdgpu driver's PPT reading (chip and memory) on the AMD cards and the Windows Energy Meter's GPU rail on the Z13. Host CPUs, RAM, power supplies and network gear are outside it. Idle draw is measured, never subtracted.
- **Clean measurements.** A run refuses to start on busy GPUs, and a measurement window in which another process used a measured GPU is flagged, not averaged in. That check works only where the harness can see processes: not on the Z13 or the four AMD cards, and not for Windows programs on gamingrig's cards.

My coding agents wrote the harness, the analyses and every kernel candidate. I supplied the hardware, the limits and the go/no-go calls. I also did the physical work: bringing up the rig's eleven cards, cabling machines and moving the RX 6600s out from behind a PCIe switch, where they hung at load.

## The first fast result was garbage

GLM-5.3's 45 blocks come in two kinds. The 11 sparse-attention (DSA) blocks are the only ones with a KV cache, and the 34 KDA blocks keep a recurrent state instead.

My first fifteen-GPU layout for this model reported a plausible 0.0103 to 0.0105 tokens per joule. The answers were garbage, strings like "yszyszysz..." run out to the 384-token cap.

Nothing had failed.

DSA blocks build their attention mask with `GGML_OP_TOP_K_MASK`, an op that llama.cpp's Vulkan backend in b11960 doesn't implement. It skips the node silently and reports success. The RPC client answers "supported" for every op, so the startup check can't see the gap. That layout had put two DSA blocks on the rig's AMD cards, which attended with a mask of stale memory.

My harness checked that each answer repeated across windows, and garbage repeats perfectly. The tell was the draft head, an extra block that guesses tokens for the full model to check. In the first run that used it, each request drafted 1,143 tokens and not one was accepted.

The fix, layout `fleet15v2`, reorders the rig so its four Vulkan cards hold only KDA blocks. That costs three more handoffs between CUDA and Vulkan cards per token, each a round trip through GPURIG.

As measurements of the model, the first layout's results are void, and none appears below.

The valid baseline, run 883b7a, is a plain run, without the draft head. It made 0.0090 tokens per joule: 4.97 tokens per second at 551 W across the fifteen GPUs, and 166.5 ms per token while writing.

That run had gamingrig's two cards at high clocks. At default settings they sit at high or idle clocks for a whole run, for reasons I never settled. Every later run landed at idle, apart from part of one while I browsed on gamingrig.

## The wire is not the wall for writing

With one request at a time, the layer split works like a relay: only one card works at any moment, and a token takes as long as all the turns and hops added together.

To see where a written (decoded) token's time goes, I profiled run a78bca with llama.cpp's RPC and scheduler logging turned up. Its mean decode token took 229.5 ms. Plain runs in the same idle-clock state took 227.1 to 227.8 ms, so the logging costs about 1%.

![Stacked horizontal bar of one mean decode token, 229.5 ms, in profiling run a78bca with gamingrig's GPUs at idle clocks. Device turns: Z13 44.0 ms; the rig, 14 turns over 11 cards, 45.1 ms; gamingrig, 4 turns on 2 cards, 72.3 ms; A6000 compute and sampling 9.2 ms. Then network 34.8 ms, 15 percent of the token; the RPC servers' extra replies, such as the read after each failed CUDA-to-Vulkan copy, 17.4 ms, 12.3 ms of it on the rig; and GPURIG's client time 6.7 ms. RPC command handling inside the device turns is at most 45.5 ms. Below, a second bar with no breakdown: the plain token in run 883b7a, gamingrig at high clocks, 166.5 ms.](/images/fifteen-gpus-one-model/token-time.svg)

The Z13's turn on blocks 0–19 took 44.0 ms, an estimated 27 ms of it GPU work. The rig's eleven cards took 45.1 ms between them, and gamingrig's two took 72.3 ms at idle clocks. With gamingrig at high clocks the plain token takes 166.5 ms, so that clock state alone is worth about 60 ms.

The network took 34.8 ms, and the A6000's blocks and sampling 9.2 ms. The rest is RPC overhead: 6.7 ms of client time on GPURIG, and 17.4 ms of the RPC servers handling extra replies, such as the read after each failed CUDA-to-Vulkan copy. Inside the device turns, RPC command handling takes up to 45.5 ms more.

For writing, then, the wire is about 15% of this token. It is not the wall, and it is not free.

## Reading a prompt runs at about 30 tokens per second

Reading the prompt (prefill) is the slow direction. On three long prompts cut from llama.cpp's server README, one run per setup, it ran at about 30 tokens per second, flat across lengths:

| Prompt tokens | First token, plain | First token, 2 drafts |
|---:|---:|---:|
| 2,159 | 77.5 s | 77.6 s |
| 5,500 | 184.1 s | 185.3 s |
| 13,376 | 446.9 s | 449.1 s |

A 13K-token prompt waits about seven and a half minutes for its first token. The draft head adds 0.2 to 0.7%, if anything less: my browsing favored the plain run.

Reading handles many tokens per pass, so it should be far faster than writing. Here it runs at only about six times the baseline's output rate, 30 against 4.97 tokens per second. I didn't profile it, so I can't say how much of it is the wire.

## Most of the GPU energy goes to waiting

The baseline's 551 W sums fifteen meters, and the three kinds of meter draw the boundary in different places.

![Paired horizontal bars per GPU in plain run 883b7a: percent of the weights held, then of GPU energy. Z13 Radeon 8060S, GPU rail only: 41.0 and 1.6. The rig's seven 8 GB NVIDIA cards hold 2.3 each and draw 3070 FE 6.8, 3060 Ti ZOTAC 7.2, GTX 1080 7.8, GTX 1070 6.8, 3060 Ti EVGA 9.0, RTX 2080 7.1 and 3070 ASUS 7.8; together 16.4 and 52.6. Rig AMD: RX 5700 XT 3.1 and 3.6; RX 6600s at blocks 25 to 26, 28 and 29: 3.3 and 1.3; 3.1 and 1.5; 2.3 and 1.1. On gamingrig, at high clocks: 2080 Ti 3.1 and 10.8; 4090 8.7 and 10.3. GPURIG's A6000: 19.3 and 17.2. Below, 565 W while generating: deep-idle floor 260 W, 46 percent; awake premium 261 W, 46 percent; work 44 W, 8 percent. Awake with nothing to do: 521 W, 92 percent. Power samples read 2.5 percent above the meters' 551 W.](/images/fifteen-gpus-one-model/energy.svg)

The seven 8 GB NVIDIA cards on the rig hold 16.4% of the weights. They drew 52.6% of the GPU energy in the baseline, and about 64% in the full runs at idle clocks. By NVML's readings, each ran a kernel less than 2% of the time.

In every full run, at least **83%** of the fleet's GPU energy was drawn while the card drawing it had no kernel running. That is a floor: it charges kernel time at the card's full power limit.

The power samples, which sum 2.5% above the meters, show why. The baseline fleet drew 565 W while generating. With the model loaded and nothing to do, 5 to 15 seconds after a request, it still drew 521 W, 92% as much, before settling to 260 W. Only 8% of the generating draw is the work itself, and 9 to 11% in the full runs at idle clocks.

The eight NVIDIA cards on native Linux, the A6000 and the rig's seven, stay awake for about 15 seconds after a request ends. With a turn every few hundred milliseconds, they never drop. The AMD cards and the Z13 have no awake level: by the first idle reading, 5 to 15 seconds after a request, they were already at idle draw, so they wait cheaply between turns. An RX 6600 idles at 3 W and averages 5 to 8 W while generating.

## The meters can't say whether each card earns its power

Because the cards spend most of their energy waiting, the board can matter more than the chip. The EVGA RTX 3060 Ti draws about 10 W more than the ZOTAC, with the same chip and one block each, though of different kinds. The gap shows at idle too, and per GiB held, the EVGA costs more energy than any other card.

The old Pascal cards cost about what the rig's Ampere cards do. Of the fleet's 111 J per output token, the GTX 1080 and 1070 take 8.6 and 7.6 J, inside the 7.6 to 10.0 J of the rig's two RTX 3070s and two RTX 3060 Tis.

The Z13 holds 41% of the weights for 1.6% of the energy, but that is its GPU rail, which leaves out the tablet's memory.

At idle clocks gamingrig's two cards drew 88 W less. But the run took 31% longer, and the cards that wait at working power waited longer. Fleet tokens per joule fell 7.7%.

So does every card earn its power? I can't name a card that doesn't, and I can't show that each one does: the test is a run without that card, and no run left one out. All fifteen was the rule.

The cheapest holders per GiB are also slow per block. The Z13's twenty blocks take 44 ms of every token. Each RX 6600 takes 6.5 to 9.7 ms, against 1.1 to 1.7 ms for each Ampere card on the rig. What the meters do show is that most of the energy goes to waiting, not work.

## The model's own draft head was the biggest lever

GLM-5.3 carries its own multi-token-prediction (MTP) head, a 5.1 GiB block called `blk.45`. In speculative decoding the head drafts a few tokens, and the full model checks them all in one batched pass, a step, so one trip through fifteen GPUs can yield several tokens. The full model keeps the longest run of drafts that matches its own greedy choices, plus one token of its own.

The head's draft cache has to stay on the A6000, which had no room for the whole head beside blocks 37–44 and the output head, so 1,890 MiB of its expert weights sit on an RX 6600.

![Two small multiples from screening runs of 4 prompts on all 15 GPUs, gamingrig at idle clocks, one run per draft count. Left, columns of tokens per joule by drafts per step: plain 0.00798, 1 draft 0.01034, 2 drafts 0.01108, highlighted as the highest, 3 drafts 0.01096, 4 drafts 0.01060. Right, points for time per decode step: plain 228 ms, hollow and outside the fit, then 305, 374, 429 and 495 ms for 1 to 4 drafts, on a dashed least-squares line from 245 ms rising about 62 ms per extra draft. Point labels give tokens per step: 1.00, 1.85, 2.43, 2.72 and 3.01. Tokens per joule cover the 4-prompt window; step times and tokens per step cover all 5 requests, warm-up included.](/images/fifteen-gpus-one-model/draft-sweep.svg)

In short screening runs of four prompts, each extra draft added about 62 ms to a step. I didn't profile where that time goes; the likely parts are the head's own pass and the larger verify batch, where each extra token reads its own experts. Each later draft is less likely to be accepted, so past two drafts the extra time outgrows the extra tokens. Two drafts scored highest, with three within about 1%, too close for single short runs to separate.

The measured run, 95c8ab, used two drafts and the baseline's full settings, against 5e93b3, a plain run in the same clock state:

| | Plain | Two drafts |
|---|---:|---:|
| Tokens per joule | 0.00833 | **0.01174** |
| Tokens per second | 3.79 | **5.34** |
| GPU power | 455 W | 455 W |
| Decode, ms per token | 227.1 | **151.7** |
| First token, median | 7.95 s | 7.97 s |

Two drafts made **1.41x** the tokens per joule at the same power, and throughput rose by the same factor. Writing alone sped up 1.50x; prompt reading did not. Most of the power pays for cards waiting, so the whole speedup became tokens per joule.

The model accepted 73% of drafts, 83% at the first position and 63% at the second, for 2.46 tokens per step. From then on, two drafts were the default on the fleet.

## Greedy, but not identical

Decoding is greedy throughout, so in exact arithmetic the drafts would change the speed and nothing else.

They changed **seven of the eight answers**.

Each setup repeats itself exactly, window after window.

The arithmetic prompt shows how a split starts. Both versions open the same way, up to a heading, "Step 2: Tokens per Joule", which plain continues with "(efficiency)" and two drafts with "(throughput efficiency)". Both reach the correct 0.0727 tokens per joule.

The cause is inferred, not traced. The verify pass scores three tokens at once, and that batched math rounds differently from scoring one token at a time, so near-ties can flip. Both are still the model's greedy answers under different rounding, and I'm not claiming either is better. It also means the 1.41x compares the same prompts, not the same answers.

## The megakernel idea became seven small fusions

The project is called Mega Kernel: Token Per Watt, after the idea of fusing a large computation into one persistent GPU kernel, a megakernel. Profiling had to earn it.

Mirage, an existing persistent-kernel system, runs BF16 Hugging Face models on NVIDIA GPUs, multi-GPU over NVSHMEM. It has no path for GGUF weights, AMD cards or llama.cpp RPC, and this fleet needs all three.

So the kernel work became CUDA changes inside llama.cpp, measured where a small change can show: the slice, a single-GPU testbed that runs blocks 0–7 of the same model on the A6000 alone. Its text is meaningless without the rest of the model, but its per-block kernels and energy are real.

One stock decode token on the slice runs about 640 kernels and 34 device-to-device copies in 6.07 ms. The 115 weight GEMVs (matrix-vector products) take 4.79 ms at 84 to 92% of the card's 768 GB/s peak. They are already near the memory limit, so no kernel, however big, could make most of the token much faster.

What is left is 1.28 ms of small kernels, copies and gaps. Even a nearly empty kernel costs about a microsecond, and there are 525 of them. A megakernel would go after that 1.28 ms, and fusions inside llama.cpp go after the same time on a stack Mirage cannot run.

![Stacked horizontal bars of one decode token on the RTX A6000 running blocks 0 to 7 of the model, the median of 30 tokens in Nsight Systems traces. Stock, about 640 kernels: weight GEMVs 4.79 ms plus everything else 1.28 ms, 6.07 ms in all. Round 1, four fusions, 436 kernels: 4.81 plus 0.93, 5.74 ms, promoted. Round 2, three more, 363 kernels: 4.80 plus 0.75, 5.55 ms, not promoted. Everything else is small kernels, copies and the gaps between them; the GEMVs already read weights at 84 to 92 percent of the 768 GB/s peak.](/images/fifteen-gpus-one-model/kernel-time.svg)

The campaign's rules were committed before any candidate existed. A candidate had to pass `test-backend-ops`, then match stock's greedy output on the eight prompts or stay within KL-divergence and top-1 bounds. Promotion to champion needed at least 3% more tokens per joule than the current champion, over 5 paired runs in a balanced order fixed in advance. The 95% confidence interval had to sit above 1.0, time to first token could not regress more than 5%, and the budget was 4 hours and 30 attempts.

Round 1 bundled four fusions:

- **hc-fold** computes the hyper-connection mixing weights inside the existing fused kernels: 128 fewer launches per token.
- **quantize-once** converts an activation that several GEMVs share to 8-bit once, not once per GEMV.
- **kda-chains** fuses each KDA block's short chains into one kernel each: the convolution and SiLU on q, k and v, and the four-step decay gate.
- **conv-copy** has the kernel that builds each KDA convolution window also store it, removing 18 strided copies.

The bundle brought a token to 436 kernels, 16 copies and 5.74 ms. It is bit-exact by design, with the same float operations in the same order, and every check agrees: greedy output was identical on all eight prompts, and perplexity matched stock to every printed digit.

It made 5.7% more tokens per joule than stock (95% confidence interval 5.6 to 5.8%) at the same power, about 295 W. On held-out long prompts, where prompt reading dominates, one short run of each gave 0.8%.

![Dot plot of paired tokens-per-joule ratios, candidate over base, on an axis from 1.00 to 1.07 with a dashed promotion bar at 1.03. Round 1 against stock: screening run 1.0539, hollow and not counted; pairs 1.0569, 1.0564, 1.0573, 1.0564 and 1.0587; mean 1.0572, 95 percent interval 1.0560 to 1.0583, promoted. Round 2 against round 1: screening run 1.0235, not counted; pairs 1.0286, 1.0276, 1.0281, 1.0266 and 1.0270; mean 1.0276, interval 1.0266 to 1.0286, under the bar, not promoted.](/images/fifteen-gpus-one-model/kernel-pairs.svg)

Round 2 added three more fusions, for 363 kernels and 5.55 ms. They measured 2.8% more tokens per joule than round 1 (interval 2.7 to 2.9%): real, tight, and under the bar, so not promoted. The campaign stopped at "budget reached" after 5 of its 30 attempts, with too little of its 4 hours left for another round.

## On the fleet, the kernel win disappeared

The champion, round 1's bundle, went to every NVIDIA card in the fleet as one CUDA build for all four architectures. With two drafts it made 0.01173 tokens per joule, and the stock runs before and after it made 0.01174 and 0.01166.

No measurable change, and three things explain it.

First, resolution: the two stock runs differ by 0.7%, so a pair of runs can't resolve an effect below about 1%.

Second, scale: the fusions saved about 0.33 ms per pass through the slice's 8 blocks. Scaled to the fleet's 20 CUDA blocks, that is under 1 ms per pass. A two-draft pass yields about 2.5 tokens, so the saving is well under 1% of a 152 ms token, as a rough estimate.

Third, I never traced whether every fusion fires inside llama.cpp's RPC servers.

Round 2 was never measured on the fleet, and it would have done even less there: its fusions skip the 3-token verify batches that two drafts produce.

The answers held: all eight were byte-identical to the stock two-draft run. One slip: the op tests meant for gamingrig's two cards both ran on the 4090, so the 2080 Ti never ran them. The rig's RTX 2080 covers its architecture, and the 2080 Ti did run the champion.

## What I would tell someone pooling old cards

**Check the work behind a speed figure.** A determinism check passes garbage. A draft head that accepts nothing does not.

**Profile before fusing.** The big kernels were already near the memory limit, so seven fusions inside llama.cpp went after the 1.28 ms of small kernels and gaps. The win was real on one card and too small to see on fifteen.

**With one request at a time, most GPU energy goes to waiting.** Cards that drop straight to idle wait cheaply, and cards that stay awake pay nearly full price through every other card's turn.

**Fifteen cards on one model is a capacity result.** Together they hold a 320B model at a 16K context, with the Z13 and the A6000 holding 60% of it.

I still intend to sell some of the older cards. Each one held a share of a 320B model first, and mostly waited.
