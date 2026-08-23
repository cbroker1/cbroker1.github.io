/**
 * Assistant UI behaviour.
 *
 * This is the only assistant code that ships on every page load, so it stays
 * small and knows nothing about retrieval or models. The controller — and with
 * it the corpus, the index and the runtime — is dynamically imported the first
 * time a visitor shows any intent, so a visitor who never opens the panel
 * downloads nothing beyond this file.
 */

import type { Assistant, AssistantAnswer, ModelState } from './controller.ts';

/**
 * Retrieval takes about five milliseconds, which reads as nothing having
 * happened at all. A brief, visible beat makes a fast answer feel considered
 * instead of canned — and it is the same beat the model path takes anyway.
 */
const MIN_THINKING_MS = 2000;

const INPUT_MAX_HEIGHT = 96;

const INVITE_DELAY_MS = 10_000;
const INVITE_VISIBLE_MS = 9_000;
const INVITE_KEY = 'pa-invite-seen';

const STATUS = {
  searching: "Searching Carl's site…",
  writing: 'Writing an answer…',
  excerpting: 'Finding the closest passage…',
  ready: 'Answer ready.',
  fallbackSuffix: 'Showing passages from the site instead.',
  failedLoad: "The local answer model couldn't load.",
  failedGenerate: 'The local answer model stopped partway through.',
};

export function mountAssistant(): void {
  const root = document.querySelector<HTMLElement>('[data-assistant]');
  if (!root) return;

  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;

  const launcher = q<HTMLButtonElement>('[data-launcher]');
  const panel = q<HTMLElement>('[data-panel]');
  const log = q<HTMLElement>('[data-log]');
  const form = q<HTMLFormElement>('[data-form]');
  const input = q<HTMLTextAreaElement>('[data-input]');
  const send = q<HTMLButtonElement>('[data-send]');
  const statusLine = q<HTMLElement>('[data-status]');
  const invite = q<HTMLElement>('[data-invite]');
  const resetButton = q<HTMLButtonElement>('[data-reset]');
  const battery = q<HTMLElement>('[data-battery]');
  const banner = q<HTMLElement>('[data-banner]');

  /**
   * The empty-state block, captured before anything is appended to the log.
   * Reset re-inserts a clone, so clearing the conversation genuinely returns the
   * panel to how it looked on first open — chips included.
   */
  const introTemplate = q<HTMLElement>('.pa-intro').cloneNode(true) as HTMLElement;
  const corpusUrl = root.dataset.corpus ?? '/assistant/corpus.json';

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let assistant: Assistant | null = null;
  let assistantLoading: Promise<Assistant> | null = null;
  let modelState: ModelState = { kind: 'idle' };
  let busy = false;
  let open = false;
  let inFlight: AbortController | null = null;
  let inviteTimer: number | undefined;
  let hideInviteTimer: number | undefined;

  root.hidden = false;

  /* ---------------------------------------------------------------- status */

  const renderStatus = () => {
    if (busy) {
      if (modelState.kind === 'loading') {
        statusLine.textContent = `Preparing local AI… ${Math.round(modelState.percent)}%`;
        showBattery(modelState.percent);
        hideBanner();
      } else if (modelState.kind === 'unsupported' || modelState.kind === 'failed') {
        statusLine.textContent = STATUS.excerpting;
        hideBattery();
        showBanner(false);
      } else {
        statusLine.textContent = STATUS.writing;
        hideBattery();
        hideBanner();
      }
      return;
    }
    if (modelState.kind === 'loading') {
      statusLine.textContent = `Loading LLM in your browser… ${Math.round(modelState.percent)}% — the wait is worth it`;
      showBattery(modelState.percent);
      hideBanner();
      return;
    }
    if (modelState.kind === 'unsupported') {
      statusLine.textContent = `${modelState.reason} ${STATUS.fallbackSuffix}`;
      hideBattery();
      showBanner(false);
    } else if (modelState.kind === 'failed') {
      const reason = modelState.scope === 'generate' ? STATUS.failedGenerate : STATUS.failedLoad;
      statusLine.textContent = `${reason} ${STATUS.fallbackSuffix}`;
      hideBattery();
      showBanner(false);
    } else if (modelState.kind === 'ready') {
      statusLine.textContent = '';
      hideBattery();
      showBanner(true);
    } else {
      statusLine.textContent = '';
      hideBattery();
      hideBanner();
    }
  };

  /** Fill battery segments based on percent (0-100). */
  const showBattery = (percent: number) => {
    if (!battery) return;
    battery.hidden = false;
    battery.classList.add('is-loading');
    const segs = battery.querySelectorAll('.pa-battery__seg');
    const filled = Math.ceil((percent / 100) * segs.length);
    segs.forEach((seg, i) => {
      seg.classList.toggle('is-full', i < filled);
      seg.classList.toggle('is-half', i === filled && filled < segs.length);
    });
  };

  const hideBattery = () => {
    if (!battery) return;
    battery.hidden = true;
    battery.classList.remove('is-loading');
    battery.querySelectorAll('.pa-battery__seg').forEach((seg) => {
      seg.classList.remove('is-full', 'is-half');
    });
  };

  /** Show/hide the post-load status banner. */
  const showBanner = (ready: boolean) => {
    if (!banner) return;
    banner.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => banner.classList.add('is-visible')));
    if (!ready) {
      banner.querySelector('.pa-banner__meta')!.textContent = 'Model unavailable — Showing passages from the site instead.';
      banner.querySelector('.pa-banner__icon')!.style.backgroundColor = 'var(--color-text-muted-light)';
    } else {
      banner.querySelector('.pa-banner__meta')!.textContent = 'Powered by: Qwen3-1.7B · Transformers.js';
      banner.querySelector('.pa-banner__icon')!.style.backgroundColor = '';
    }
  };

  const hideBanner = () => {
    if (!banner) return;
    banner.classList.remove('is-visible');
    window.setTimeout(() => { banner.hidden = true; }, 300);
  };

  /* ------------------------------------------------------------ lazy loads */

  const getAssistant = (): Promise<Assistant> => {
    assistantLoading ??= import('./controller.ts').then(({ createAssistant }) => {
      assistant = createAssistant({
        corpusUrl,
        onModelState: (state) => {
          modelState = state;
          renderStatus();
        },
      });
      return assistant;
    });
    return assistantLoading;
  };

  /** Cheap warm-up on intent: fetches and indexes the corpus, no model. */
  const warmCorpus = () => {
    void getAssistant().then((instance) => instance.warmCorpus().catch(() => undefined));
  };

  /* ---------------------------------------------------------------- panel */

  /**
   * Only a touch-primary device should be spared the autofocus — its keyboard
   * would swallow the panel. Testing for `pointer: fine` instead would also skip
   * focusing anywhere without a pointing device at all, which is the wrong call.
   */
  const isTouchPrimary = () => window.matchMedia('(pointer: coarse)').matches;

  const openPanel = () => {
    if (open) return;
    open = true;
    dismissInvite();
    root.classList.add('is-open');
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.add('is-open')));
    resizeInput(); // First real measurement: the field now has layout.
    if (!isTouchPrimary()) input.focus({ preventScroll: true });

    void getAssistant().then((instance) => {
      void instance.warmCorpus().catch(() => undefined);
      void instance.warmModel();
    });
  };

  const closePanel = () => {
    if (!open) return;
    open = false;
    // Generation deliberately keeps running: reopening should show the answer
    // rather than a question the assistant appears to have ignored.
    root.classList.remove('is-open');
    panel.classList.remove('is-open');
    launcher.setAttribute('aria-expanded', 'false');

    const finish = () => {
      if (!open) panel.hidden = true;
    };
    if (reducedMotion.matches) finish();
    else window.setTimeout(finish, 300);

    launcher.focus({ preventScroll: true });
  };

  launcher.addEventListener('click', () => (open ? closePanel() : openPanel()));
  q('[data-close]').addEventListener('click', closePanel);

  launcher.addEventListener('pointerenter', warmCorpus, { once: true });
  launcher.addEventListener('pointerdown', warmCorpus, { once: true });
  launcher.addEventListener('focus', warmCorpus, { once: true });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      closePanel();
    }
  });

  /* -------------------------------------------------------------- invite */

  const dismissInvite = () => {
    window.clearTimeout(inviteTimer);
    window.clearTimeout(hideInviteTimer);
    invite.classList.remove('is-visible');
    invite.hidden = true;
    root.removeAttribute('data-attention');
    try {
      sessionStorage.setItem(INVITE_KEY, '1');
    } catch {
      /* Private mode: the invitation simply shows once per page instead. */
    }
  };

  const showInvite = () => {
    if (open) return;
    invite.hidden = false;
    root.setAttribute('data-attention', '');
    requestAnimationFrame(() => requestAnimationFrame(() => invite.classList.add('is-visible')));
    hideInviteTimer = window.setTimeout(dismissInvite, INVITE_VISIBLE_MS);
  };

  let inviteSeen = false;
  try {
    inviteSeen = sessionStorage.getItem(INVITE_KEY) === '1';
  } catch {
    inviteSeen = false;
  }
  if (!inviteSeen) inviteTimer = window.setTimeout(showInvite, INVITE_DELAY_MS);

  q('[data-invite-open]').addEventListener('click', openPanel);
  q('[data-invite-dismiss]').addEventListener('click', dismissInvite);

  /* ------------------------------------------------------------ rendering */

  const isPinned = () => log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  const scrollToEnd = () => {
    log.scrollTop = log.scrollHeight;
  };

  /** Renders plain text as paragraphs and simple bullet lists. No HTML ever. */
  const renderText = (target: HTMLElement, text: string) => {
    target.textContent = '';
    const blocks = text.split(/\n{2,}/);

    for (const block of blocks) {
      const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
      const bullets = lines.filter((line) => /^[-*•]\s+/.test(line));

      if (bullets.length && bullets.length === lines.length) {
        const list = document.createElement('ul');
        for (const line of lines) {
          const item = document.createElement('li');
          item.textContent = line.replace(/^[-*•]\s+/, '');
          list.append(item);
        }
        target.append(list);
        continue;
      }

      const paragraph = document.createElement('p');
      paragraph.textContent = lines.join(' ');
      if (paragraph.textContent) target.append(paragraph);
    }
  };

  /**
   * ChatGPT-style typewriter: renders text character by character at ~30 chars/sec.
   * Buffers all tokens in `typewriterBuffer`, then animates from the last displayed
   * index to the current buffer length. The RAF runs continuously until generation
   * finishes, so rapid token bursts never cancel the animation.
   */
  let typewriterRAF: number | null = null;
  let typewriterBuffer = '';
  let typewriterIndex = 0;
  let typewriterTargetEl: HTMLElement | null = null;
  const TYPEWRITER_MS_PER_CHAR = 33; // ~30 chars/sec

  const renderTypewriter = (target: HTMLElement, cursor: HTMLElement, newText: string) => {
    // Just update the buffer — don't cancel the RAF.
    // If the RAF is already running, it will pick up the new buffer length on the next tick.
    // If it's not running (e.g. it finished a previous answer), start it now.
    typewriterBuffer = newText;
    typewriterTargetEl = target;

    if (typewriterRAF !== null) return;

    const startTime = performance.now();
    const startIdx = typewriterIndex;

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const charsToShow = Math.min(
        typewriterBuffer.length,
        startIdx + Math.floor(elapsed / TYPEWRITER_MS_PER_CHAR)
      );

      const visible = typewriterBuffer.slice(0, charsToShow);
      renderText(typewriterTargetEl!, visible);
      typewriterTargetEl!.append(cursor);

      typewriterIndex = charsToShow;
      typewriterRAF = requestAnimationFrame(tick);
    };

    typewriterRAF = requestAnimationFrame(tick);
  };

  /** Stop any running typewriter and render the full text immediately. */
  const stopTypewriter = () => {
    if (typewriterRAF !== null) {
      cancelAnimationFrame(typewriterRAF);
      typewriterRAF = null;
    }
    typewriterIndex = typewriterBuffer.length;
  };

  const renderSources = (target: HTMLElement, answer: AssistantAnswer) => {
    if (!answer.sources.length) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'pa-sources';

    const label = document.createElement('span');
    label.className = 'pa-sources__label';
    label.textContent = answer.sources.length === 1 ? 'Source' : 'Sources';
    wrapper.append(label);

    for (const source of answer.sources) {
      const row = document.createElement('div');
      row.className = 'pa-source';

      const title = document.createElement('span');
      title.className = 'pa-source__title';
      title.textContent = source.title;
      row.append(title);

      const links = document.createElement('div');
      links.className = 'pa-source__links';
      for (const link of source.links) {
        const anchor = document.createElement('a');
        anchor.className = 'pa-source__link';
        anchor.href = link.href;
        anchor.textContent = link.label;
        if (/^https?:/i.test(link.href)) {
          anchor.target = '_blank';
          anchor.rel = 'noopener noreferrer';
        }
        links.append(anchor);
      }
      row.append(links);
      wrapper.append(row);
    }

    target.append(wrapper);
  };

  const startTurn = (question: string) => {
    log.querySelector('.pa-intro')?.remove();
    resetButton.hidden = false;

    const turn = document.createElement('div');
    turn.className = 'pa-turn';

    const asked = document.createElement('div');
    asked.className = 'pa-turn__question';
    asked.textContent = question;

    const answer = document.createElement('div');
    answer.className = 'pa-turn__answer';
    answer.setAttribute('aria-hidden', 'true'); // Unmuted once the answer settles.

    const thinking = document.createElement('div');
    thinking.className = 'pa-thinking';
    const thinkingLabel = document.createElement('span');
    thinkingLabel.textContent = 'Thinking';
    const dots = document.createElement('span');
    dots.className = 'pa-thinking__dots';
    dots.append(
      document.createElement('span'),
      document.createElement('span'),
      document.createElement('span')
    );
    thinking.append(thinkingLabel, dots);
    answer.append(thinking);

    const cursor = document.createElement('span');
    cursor.className = 'pa-typing';

    turn.append(asked, answer);
    log.append(turn);
    scrollToEnd();

    return { answer, cursor, thinking };
  };

  /** Returns the panel to its opening state, discarding the conversation. */
  const resetConversation = () => {
    inFlight?.abort();
    inFlight = null;
    assistant?.clearConversation();

    log.textContent = '';
    log.append(introTemplate.cloneNode(true));
    resetButton.hidden = true;
    log.scrollTop = 0;

    statusLine.textContent = 'Conversation cleared.';
    window.setTimeout(() => {
      if (statusLine.textContent === 'Conversation cleared.') renderStatus();
    }, 2500);

    if (!isTouchPrimary()) input.focus({ preventScroll: true });
  };

  resetButton.addEventListener('click', resetConversation);

  /** Holds the answer back until the thinking beat has actually been seen. */
  const settle = (startedAt: number) => {
    const remaining = MIN_THINKING_MS - (performance.now() - startedAt);
    if (remaining <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
  };

  /* ---------------------------------------------------------------- asking */

  const ask = async (question: string) => {
    if (busy || !question.trim()) return;

    busy = true;
    input.value = '';
    resizeInput();
    renderStatus();

    const { answer, cursor, thinking } = startTurn(question.trim());
    const startedAt = performance.now();
    let streamed = false;
    const controller = new AbortController();
    inFlight = controller;

    statusLine.textContent = STATUS.searching;

    try {
      const instance = await getAssistant();
      renderStatus(); // Retrieval is done; show model progress or "writing".
      const result = await instance.ask(question.trim(), {
        signal: controller.signal,
        onToken: (text) => {
          if (!text) return;
          streamed = true;
          // Start typewriter on first token; keep thinking indicator visible
          renderTypewriter(answer, cursor, text);
          const pinned = isPinned();
          if (pinned) scrollToEnd();
        },
      });

      // Generation done — stop typewriter mid-animation and render full text
      stopTypewriter();

      // Settle first so every answer (declined, extractive, or generated) gets
      // the same thinking beat before the answer is revealed.
      await settle(startedAt);

      if (result.mode === 'declined') {
        // No model was available or it declined — show the fallback with typewriter.
        // Use a fresh clock for the fallback beat since retrieval has already
        // consumed time from the original startedAt.
        const fallbackText = "I don't have enough information in Carl's public portfolio to answer that confidently. This site covers 3 project write-ups, 2 technical articles, his career history and background.";
        // Reset typewriter state so it starts from zero (not from the end of the
        // previous answer's text where typewriterIndex was left).
        typewriterIndex = 0;
        typewriterBuffer = '';
        const fallbackStart = performance.now();
        // Wait long enough for the typewriter to finish typing + extra thinking time,
        // so the dots stay visible for the entire animation instead of vanishing mid-stream.
        const typewriterDuration = fallbackText.length * TYPEWRITER_MS_PER_CHAR;
        const fallbackSettle = () => {
          const remaining = typewriterDuration + 1000 - (performance.now() - fallbackStart);
          if (remaining <= 0) return Promise.resolve();
          return new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
        };
        renderTypewriter(answer, cursor, fallbackText);
        await fallbackSettle();
        thinking.remove();
        stopTypewriter();
        renderText(answer, typewriterBuffer);
      } else {
        // Generated or extractive — render text, clean up thinking/cursor.
        renderText(answer, typewriterBuffer);
        cursor.remove();
        thinking.remove();
        answer.removeAttribute('aria-hidden');
        if (!streamed) answer.classList.add('pa-turn__answer--enter');

        if (result.mode === 'extractive') {
          const label = document.createElement('span');
          label.className = 'pa-turn__label';
          label.textContent = "From Carl's site";

          const quote = document.createElement('blockquote');
          quote.className = 'pa-turn__quote';
          renderText(quote, result.text);

          const note = document.createElement('p');
          note.className = 'pa-turn__note';
          note.textContent = result.modelPending
            ? 'The local answer model is still downloading, so this shows the closest passage. Ask again once it is ready.'
            : 'This is the closest passage from the site, quoted directly.';

          answer.append(label, quote, note);
        } else {
          renderText(answer, result.text);
        }
      }

      renderSources(answer, result);
    } catch (error) {
      await settle(startedAt);
      cursor.remove();
      thinking.remove();
      answer.removeAttribute('aria-hidden');
      if (!controller.signal.aborted) {
        renderText(
          answer,
          "Something went wrong reaching Carl's site content. The rest of the site is unaffected — please try again."
        );
      }
    } finally {
      if (inFlight === controller) inFlight = null;
      busy = false;
      resizeInput();
      renderStatus();
      if (isPinned()) scrollToEnd();
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void ask(input.value);
  });

  log.addEventListener('click', (event) => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-suggestion]');
    if (chip?.dataset.suggestion) void ask(chip.dataset.suggestion);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void ask(input.value);
    }
  });

  function resizeInput() {
    send.disabled = busy || !input.value.trim();

    input.style.height = 'auto';
    const natural = input.scrollHeight;

    // A hidden panel has no layout, so `scrollHeight` is 0. Writing that back as
    // a height collapses the field and pushes the placeholder out of view — the
    // CSS `min-height` handles this case, so leave the height alone.
    if (!natural) {
      input.style.height = '';
      return;
    }

    const overflowing = natural > INPUT_MAX_HEIGHT;
    // `scrollHeight` comes back as a whole pixel. With border-box sizing that
    // rounding can leave the field a hair shorter than its own line, which makes
    // the placeholder scroll instead of sitting still — hence the extra pixel.
    input.style.height = `${overflowing ? INPUT_MAX_HEIGHT : natural + 1}px`;
    input.style.overflowY = overflowing ? 'auto' : 'hidden';
  }

  input.addEventListener('input', resizeInput);
  resizeInput();
  // Inter loads asynchronously; the first measurement uses fallback metrics.
  document.fonts?.ready.then(() => resizeInput());
}
