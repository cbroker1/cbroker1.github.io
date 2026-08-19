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
const MIN_THINKING_MS = 750;

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
      } else if (modelState.kind === 'unsupported' || modelState.kind === 'failed') {
        statusLine.textContent = STATUS.excerpting;
      } else {
        statusLine.textContent = STATUS.writing;
      }
      return;
    }
    if (modelState.kind === 'loading') {
      statusLine.textContent = `Preparing local AI… ${Math.round(modelState.percent)}% (${modelState.approxMB} MB, one time)`;
      return;
    }
    if (modelState.kind === 'unsupported') {
      statusLine.textContent = `${modelState.reason} ${STATUS.fallbackSuffix}`;
    } else if (modelState.kind === 'failed') {
      const reason = modelState.scope === 'generate' ? STATUS.failedGenerate : STATUS.failedLoad;
      statusLine.textContent = `${reason} ${STATUS.fallbackSuffix}`;
    } else {
      statusLine.textContent = '';
    }
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

  const openPanel = () => {
    if (open) return;
    open = true;
    dismissInvite();
    root.classList.add('is-open');
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.add('is-open')));
    resizeInput(); // First real measurement: the field now has layout.
    if (window.matchMedia('(pointer: fine)').matches) input.focus({ preventScroll: true });

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
    root.querySelector('.pa-intro')?.remove();

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
          const pinned = isPinned();
          renderText(answer, text); // Replaces the thinking indicator.
          answer.append(cursor);
          if (pinned) scrollToEnd();
        },
      });

      await settle(startedAt);
      cursor.remove();
      thinking.remove();
      answer.removeAttribute('aria-hidden');
      // Streamed text is already on screen; only a one-shot answer needs easing in.
      if (!streamed) answer.classList.add('pa-turn__answer--enter');

      if (result.mode === 'extractive') {
        // Excerpts keep the site's first-person voice, so they are presented as
        // a quotation rather than as the assistant speaking.
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
