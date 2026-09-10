/** Renderer-only layout preference. It never changes Core/config authority. */
export function initSidebarResize(): void {
  const app = document.querySelector<HTMLElement>('.app');
  const sidebar = document.getElementById('tabs');
  const handle = document.getElementById('sidebarResize');
  const toggle = document.getElementById('sidebarToggle');
  if (!app || !sidebar || !handle || !toggle) return;
  const key = 'chat-on-steroids.sidebar-width';
  const minimum = 180;
  const maximum = (): number => Math.max(minimum, Math.min(480, window.innerWidth / 2));
  let preferred: number | null = null;
  let collapsed = false;
  let drag: { id: number; x: number; width: number } | null = null;
  try {
    const saved = Number(localStorage.getItem(key));
    if (Number.isFinite(saved) && saved >= minimum) preferred = Math.min(480, saved);
    collapsed = localStorage.getItem(`${key}.collapsed`) === 'true';
  } catch { /* Optional renderer preference only. */ }

  const render = (): void => {
    app.classList.toggle('is-sidebar-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Expand workspace sidebar' : 'Collapse workspace sidebar');
    if (preferred === null) app.style.removeProperty('--sidebar-width');
    else app.style.setProperty('--sidebar-width', `${Math.min(maximum(), preferred)}px`);
    handle.setAttribute('aria-valuemin', String(minimum));
    handle.setAttribute('aria-valuemax', String(maximum()));
    handle.setAttribute('aria-valuenow', String(Math.round(sidebar.getBoundingClientRect().width)));
  };
  const persistWidth = (): void => {
    try {
      if (preferred === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(preferred));
    } catch { /* Current-window layout remains usable. */ }
  };
  const setWidth = (width: number): void => {
    preferred = Math.round(Math.max(minimum, Math.min(maximum(), width)));
    render();
  };
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag || collapsed) return;
    handle.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, x: event.clientX, width: sidebar.getBoundingClientRect().width };
    app.classList.add('is-resizing-sidebar');
    event.preventDefault();
  });
  handle.addEventListener('pointermove', (event) => {
    if (drag?.id === event.pointerId) setWidth(drag.width + event.clientX - drag.x);
  });
  const finish = (event: PointerEvent): void => {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    app.classList.remove('is-resizing-sidebar');
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    persistWidth();
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('lostpointercapture', finish);
  handle.addEventListener('dblclick', () => { preferred = null; render(); persistWidth(); });
  handle.addEventListener('keydown', (event) => {
    if (collapsed) return;
    const width = sidebar.getBoundingClientRect().width;
    if (event.key === 'ArrowLeft') setWidth(width - 10);
    else if (event.key === 'ArrowRight') setWidth(width + 10);
    else if (event.key === 'Home') setWidth(minimum);
    else if (event.key === 'End') setWidth(maximum());
    else return;
    event.preventDefault();
    persistWidth();
  });
  const toggleSidebar = (): void => {
    collapsed = !collapsed;
    render();
    try { localStorage.setItem(`${key}.collapsed`, String(collapsed)); } catch { /* Optional persistence. */ }
  };
  toggle.addEventListener('click', toggleSidebar);
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      if (!event.repeat) toggleSidebar();
    }
  });
  window.addEventListener('resize', render);
  render();
}
