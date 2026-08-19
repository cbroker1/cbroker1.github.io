/**
 * Drives the real assistant panel in a headless Chrome and asserts its
 * behaviour. No dependencies: Node's built-in fetch and WebSocket speak the
 * Chrome DevTools Protocol directly.
 *
 * Screenshots miss interaction bugs. This caught two that they did: an input
 * that collapsed to nothing because it was measured while the panel was still
 * display:none, and an autofocus that silently skipped on any device without a
 * fine pointer.
 *
 * Usage:
 *   npm run build && npm run preview          # terminal 1, note the port
 *   google-chrome --headless=new --remote-debugging-port=9222 about:blank &
 *   npm run assistant:drive -- 4321           # port from `npm run preview`
 *
 * WebGPU is unavailable in headless Chrome, so the answer path exercised here
 * is the retrieval fallback. That is deliberate: it is the path every visitor
 * without WebGPU gets, and it must always work.
 */

const PORT = process.argv[2] ?? '4321';
const DEBUG_PORT = process.argv[3] ?? '9222';

let targets;
try {
  targets = await (await fetch(`http://localhost:${DEBUG_PORT}/json`)).json();
} catch {
  console.error(
    `No Chrome on :${DEBUG_PORT}. Start one with:\n` +
      `  google-chrome --headless=new --remote-debugging-port=${DEBUG_PORT} about:blank &`
  );
  process.exit(1);
}

const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('Chrome is running but exposes no page target.');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let nextId = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
};

const command = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const response = await command('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.text);
  }
  return response.result?.result?.value;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = async (expression) => JSON.parse(await evaluate(expression));

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

await command('Page.enable');
await command('Runtime.enable');
await command('Page.navigate', { url: `http://localhost:${PORT}/` });
await sleep(2500);

console.log('\ninitial state');
check('widget mounted and visible', await evaluate(`!document.querySelector('[data-assistant]').hidden`));
check('panel starts closed', await evaluate(`document.querySelector('[data-panel]').hidden === true`));
check('reset hidden with nothing to clear', await evaluate(`document.querySelector('[data-reset]').hidden === true`));

console.log('\nopening');
await evaluate(`document.querySelector('[data-launcher]').click()`);
await sleep(700);
check('panel opens', await evaluate(`document.querySelector('[data-panel]').hidden === false`));

const field = await json(`(() => { const i = document.querySelector('[data-input]');
  return JSON.stringify({ h: i.offsetHeight, sh: i.scrollHeight, focused: document.activeElement === i }); })()`);
check('input is one line tall and unclipped', field.h >= 36 && field.sh <= field.h, `offsetHeight=${field.h} scrollHeight=${field.sh}`);
check('input focused on open', field.focused);

console.log('\nasking');
await evaluate(`document.querySelector('[data-suggestion]').click()`);
await sleep(600);
check('question renders immediately', await evaluate(`!!document.querySelector('.pa-turn__question')`));
check('thinking indicator shows', await evaluate(`!!document.querySelector('.pa-thinking')`));
check('reset button appears', await evaluate(`document.querySelector('[data-reset]').hidden === false`));

await sleep(6000);
const answered = await json(`(() => { const a = document.querySelector('.pa-turn__answer');
  return JSON.stringify({ text: (a?.textContent || '').slice(0, 90),
    sources: document.querySelectorAll('.pa-source').length,
    links: [...document.querySelectorAll('.pa-source__link')].map((l) => l.getAttribute('href')),
    thinking: !!document.querySelector('.pa-thinking'),
    status: document.querySelector('[data-status]').textContent }); })()`);
check('answer renders', answered.text.length > 30, answered.text.replace(/\s+/g, ' '));
check('thinking indicator clears', !answered.thinking);
check('sources rendered', answered.sources >= 1, `${answered.sources} source(s)`);
check('every source link is real', answered.links.every((h) => /^(https?:|\/|mailto:)/.test(h)), answered.links.join(' '));
console.log(`      status: "${answered.status}"`);

console.log('\nresetting');
await evaluate(`document.querySelector('[data-reset]').click()`);
await sleep(400);
const after = await json(`(() => JSON.stringify({ turns: document.querySelectorAll('.pa-turn').length,
  intro: !!document.querySelector('.pa-intro'), chips: document.querySelectorAll('[data-suggestion]').length,
  resetHidden: document.querySelector('[data-reset]').hidden,
  status: document.querySelector('[data-status]').textContent }))()`);
check('conversation cleared', after.turns === 0, `turns=${after.turns}`);
check('empty state restored', after.intro);
check('suggestion chips restored', after.chips >= 4, `chips=${after.chips}`);
check('reset button hides again', after.resetHidden);
check('clearing is announced', /cleared/i.test(after.status), after.status);

await evaluate(`document.querySelector('[data-suggestion]').click()`);
await sleep(700);
check('restored chips still work', await evaluate(`document.querySelectorAll('.pa-turn').length === 1`));

console.log('\nclosing');
await evaluate(`document.querySelector('[data-close]').click()`);
await sleep(600);
check('panel closes', await evaluate(`document.querySelector('[data-panel]').hidden === true`));
check('focus returns to the launcher',
  await evaluate(`document.activeElement === document.querySelector('[data-launcher]')`));

console.log(failures ? `\n${failures} check(s) failed\n` : '\nAll checks passed\n');
ws.close();
process.exit(failures ? 1 : 0);
