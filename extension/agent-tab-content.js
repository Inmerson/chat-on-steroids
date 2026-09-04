(() => {
  'use strict';

  function commandMarker() {
    try {
      const url = new URL(location.href);
      const queryMarker = url.searchParams.get('clf');
      if (queryMarker) return queryMarker;
      const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
      return hash ? new URLSearchParams(hash).get('clf') : null;
    } catch {
      return null;
    }
  }

  const id = commandMarker();
  if (!id) return;

  try {
    const result = chrome.runtime.sendMessage({ type: 'agent_tab_register', id });
    if (result && typeof result.catch === 'function') result.catch(() => undefined);
  } catch {
    // Registration is a safety/lifecycle hint. Failure leaves the tab open; it never makes
    // an unproven tab eligible for automatic closure.
  }
})();
