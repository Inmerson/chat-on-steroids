/** Capture one visible logical row for a synchronous reconciliation. */
export function preserveTimelineViewport(pane: HTMLElement, timeline: HTMLElement, followBottom = true): () => void {
  const previous = pane.scrollTop;
  const following = followBottom && previous + pane.clientHeight >= pane.scrollHeight - 40;
  const edge = pane.getBoundingClientRect().top;
  const rows = () => [...timeline.querySelectorAll<HTMLElement>('[data-timeline-key]')]
    .filter((row) => !row.matches('.tool-group[open]'));
  const anchor = following ? undefined : rows().find((row) => {
    const rect = row.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > edge && rect.top < edge + pane.clientHeight;
  });
  const key = anchor?.dataset.timelineKey;
  const offset = anchor ? anchor.getBoundingClientRect().top - edge : 0;
  return () => {
    if (following) {
      pane.scrollTop = pane.scrollHeight;
      return;
    }
    const current = key ? rows().find((row) => row.dataset.timelineKey === key) : undefined;
    const rect = current?.getBoundingClientRect();
    pane.scrollTop = rect && rect.height > 0
      ? pane.scrollTop + rect.top - pane.getBoundingClientRect().top - offset
      : previous;
  };
}
