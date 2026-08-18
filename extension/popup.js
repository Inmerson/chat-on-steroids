/**
 * Status UI. The only place a human interacts with the extension directly.
 *
 * There is nothing to fill in: asking for the app's status is also what provisions this
 * browser, so opening the popup on a machine where the app is running shows "Connected"
 * and no action. What is left is the two things a human might actually want — retry the
 * search when the app was started after Chrome, and hand the token back.
 */

const $ = (id) => document.getElementById(id);
const RENDER_STREAM_KEY = 'renderStreamEnabled';
const SHOW_TIMES_KEY = 'showStreamTimes';
let overwriteEnabled = true;
let showTimes = false;

const MESSAGES = {
  app_not_found: 'The desktop app is not running, or its bridge could not start.',
  not_paired: 'The app refused this browser. Restart the app and try again.'
};

function fail(result) {
  const key = result && result.error ? result.error : '';
  $('err').textContent = MESSAGES[key] || (result && result.message) || key || 'Something went wrong.';
  $('err').hidden = false;
}

function syncOverwrite() {
  $('overwriteToggle').checked = overwriteEnabled;
  $('overwriteHint').textContent = overwriteEnabled
    ? 'Local Files owns the full assistant turn and stays on after reload.'
    : 'Stock ChatGPT activity is restored while Overwrite is off.';
}

async function loadOverwritePreference() {
  const stored = await chrome.storage.local.get([RENDER_STREAM_KEY, SHOW_TIMES_KEY]);
  overwriteEnabled = stored[RENDER_STREAM_KEY] !== false;
  showTimes = stored[SHOW_TIMES_KEY] === true;
  syncOverwrite();
  $('timeToggle').checked = showTimes;
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'status' });
  const connected = status && status.connected === true;
  const paired = status && status.paired === true;
  // Disconnected on purpose. Everything below has to say so plainly rather than
  // describing it as a connection that has not finished yet, which is what it looked
  // like back when the next poll would silently undo it.
  const off = status && status.disconnected === true && !paired;
  const ready = connected && paired;

  $('dot').className = `dot ${ready ? 'on' : off ? '' : connected ? 'warn' : ''}`;
  $('state').textContent = off
    ? 'Disconnected'
    : !connected
      ? 'App not found'
      : ready
        ? `Connected · port ${status.port}`
        : `App found on port ${status.port} · connecting…`;

  $('hint').textContent = off
    ? 'This browser will stay disconnected, including after a restart, until you connect it again.'
    : ready
      ? 'Open a ChatGPT tab and the companion starts recording that conversation.'
      : connected
        ? 'The app is there but has not handed this browser a token yet. Try again in a moment.'
        : 'The desktop app has to be running. Open it and this connects on its own.';
  $('retryBtn').hidden = ready;
  $('retryBtn').textContent = off ? 'Connect this browser' : 'Try again';
  $('unpairBtn').hidden = !paired;
  if (ready) $('err').hidden = true;
}

$('retryBtn').addEventListener('click', async () => {
  $('err').hidden = true;
  $('retryBtn').disabled = true;
  const result = await chrome.runtime.sendMessage({ type: 'pair' });
  $('retryBtn').disabled = false;
  if (!result || result.ok !== true) fail(result);
  await refresh();
});

$('unpairBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'unpair' });
  await refresh();
});

$('overwriteToggle').addEventListener('change', async () => {
  $('err').hidden = true;
  const previous = overwriteEnabled;
  overwriteEnabled = $('overwriteToggle').checked === true;
  syncOverwrite();
  try {
    await chrome.storage.local.set({ [RENDER_STREAM_KEY]: overwriteEnabled });
    // The toggle is the action. Enabling it immediately pulls the latest app timeline into
    // every known ChatGPT tab; there is deliberately no second "Overwrite now" button.
    if (overwriteEnabled) {
      const result = await chrome.runtime.sendMessage({ type: 'overwriteNow' });
      if (!result || result.ok !== true) fail(result);
    }
  } catch (err) {
    overwriteEnabled = previous;
    syncOverwrite();
    fail({ message: String(err && err.message ? err.message : err) });
  }
});

$('timeToggle').addEventListener('change', async () => {
  showTimes = $('timeToggle').checked === true;
  await chrome.storage.local.set({ [SHOW_TIMES_KEY]: showTimes });
});

void Promise.all([loadOverwritePreference(), refresh()]);
