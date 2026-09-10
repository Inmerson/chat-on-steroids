import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { initSidebarResize } from '../src/renderer/sidebar-resize.js';

let dom: JSDOM;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); });

it('bounds pointer and keyboard resizing and keeps fork navigation usable when collapsed', () => {
  dom = new JSDOM(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'), { url: 'https://local.test' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  const doc = dom.window.document;
  const app = doc.querySelector<HTMLElement>('.app')!;
  const sidebar = doc.getElementById('tabs')!;
  const handle = doc.getElementById('sidebarResize')!;
  sidebar.getBoundingClientRect = () => ({ width: parseFloat(app.style.getPropertyValue('--sidebar-width')) || 224 }) as DOMRect;
  let captured = false;
  handle.setPointerCapture = () => { captured = true; };
  handle.hasPointerCapture = () => captured;
  handle.releasePointerCapture = () => { captured = false; };
  initSidebarResize();
  const pointer = (type: string, x: number) => {
    const event = new dom.window.MouseEvent(type, { clientX: x, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: 7 });
    handle.dispatchEvent(event);
  };
  pointer('pointerdown', 224); pointer('pointermove', 1000); pointer('pointerup', 1000);
  expect(captured).toBe(false);
  expect(app.style.getPropertyValue('--sidebar-width')).toBe('480px');
  handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home' }));
  expect(app.style.getPropertyValue('--sidebar-width')).toBe('180px');
  doc.getElementById('sidebarToggle')!.click();
  expect(app.classList.contains('is-sidebar-collapsed')).toBe(true);
  expect(sidebar.hasAttribute('inert')).toBe(false);
  expect((sidebar.querySelector('[data-tab="control"]') as HTMLButtonElement).disabled).toBe(false);
  expect(dom.window.localStorage.getItem('chat-on-steroids.sidebar-width.collapsed')).toBe('true');
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'b', ctrlKey: true }));
  expect(app.classList.contains('is-sidebar-collapsed')).toBe(false);
});
