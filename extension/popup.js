/**
 * Pairing UI. The only place a human interacts with the extension directly.
 *
 * It shows what the service worker already knows and forwards two actions to it. The
 * token is never read back here — the popup only ever learns whether one exists.
 */

const $ = (id) => document.getElementById(id);

const MESSAGES = {
  app_not_found: 'The desktop app is not running, or its bridge could not start.',
  no_pairing: 'No code is being shown. Open the app: Chat → Settings → Pair extension.',
  bad_code: 'That code was wrong. The app burns a code after one wrong try — ask for a new one.',
  not_paired: 'The app no longer accepts this browser. Pair again.'
};

function fail(result) {
  const key = result && result.error ? result.error : '';
  $('err').textContent = MESSAGES[key] || (result && result.message) || key || 'Something went wrong.';
  $('err').hidden = false;
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'status' });
  const connected = status && status.connected === true;
  const paired = status && status.paired === true;

  $('dot').className = `dot ${connected && paired ? 'on' : connected ? 'warn' : ''}`;
  $('state').textContent = !connected
    ? 'App not found'
    : paired
      ? `Paired · port ${status.port}`
      : `App found on port ${status.port} · not paired`;

  $('hint').hidden = connected && paired;
  $('pairForm').hidden = !connected || paired;
  $('unpairBtn').hidden = !paired;
  if (connected && paired) {
    $('hint').hidden = false;
    $('hint').textContent = 'Open a ChatGPT tab and the companion starts recording that conversation.';
  }
}

$('pairForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('err').hidden = true;
  const code = $('code').value.replace(/\D/g, '');
  if (code.length !== 6) return fail({ error: 'bad_code' });
  $('pairBtn').disabled = true;
  const result = await chrome.runtime.sendMessage({ type: 'pair', code });
  $('pairBtn').disabled = false;
  if (!result || result.ok !== true) fail(result);
  else $('code').value = '';
  await refresh();
});

$('unpairBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'unpair' });
  await refresh();
});

void refresh();
