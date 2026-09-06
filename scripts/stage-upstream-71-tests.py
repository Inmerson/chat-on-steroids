from pathlib import Path

path = Path('test/bridge.test.ts')
source = path.read_text(encoding='utf-8')
marker = "describe('a worker chat that never opens', () => {\n"
sentinel = "offers concurrent fresh workers to their live prime page without asking the OS to foreground Chrome"

if sentinel in source:
    raise SystemExit(0)

if marker not in source:
    raise SystemExit('worker bootstrap describe marker not found')

tests = r'''
  it('offers concurrent fresh workers to their live prime page without asking the OS to foreground Chrome', async () => {
    const home = 'c0c0c0c0-1111-4222-8333-000000000b71';
    await pair();
    expect((await request('GET', `/activity?conversationId=${home}`)).status).toBe(200);

    spawn({
      workers: [{ task: 'first same-window worker' }, { task: 'second same-window worker' }],
      caller: { conversationId: home }
    });

    const placements: Array<{ id: string; active?: boolean; background?: true }> = [];
    await vi.waitFor(async () => {
      const feed = await request('GET', `/activity?conversationId=${home}`);
      const placement = feed.body.placement as { id: string; active?: boolean; background?: true } | null;
      if (placement && !placements.some((entry) => entry.id === placement.id)) placements.push(placement);
      expect(placements).toHaveLength(2);
    });

    expect(new Set(placements.map((entry) => entry.id)).size).toBe(2);
    expect(placements.every((entry) => entry.active === false)).toBe(true);
    expect(placements.every((entry) => entry.background !== true)).toBe(true);
    expect(opened).toEqual([]);
  });

  it('uses the worker redeem deadline as the single OS fallback when prime-side placement never redeems', async () => {
    vi.useFakeTimers();
    try {
      const home = 'c0c0c0c0-1111-4222-8333-000000000b72';
      await pair();
      expect((await request('GET', `/activity?conversationId=${home}`)).status).toBe(200);
      spawn({ workers: [{ task: 'fallback worker' }], caller: { conversationId: home } });

      let placement: { id: string; active?: boolean; background?: true } | null = null;
      await vi.waitFor(async () => {
        const feed = await request('GET', `/activity?conversationId=${home}`);
        placement = feed.body.placement ?? null;
        expect(placement).not.toBeNull();
      });
      expect(placement!.active).toBe(false);
      expect(placement!.background).not.toBe(true);
      expect(opened).toEqual([]);

      await vi.advanceTimersByTimeAsync(WORKER_REDEEM_MS + 1_000);
      await flushDurable();
      await vi.waitFor(() => expect(opened).toHaveLength(1));
      expect(new URL(opened[0]!).searchParams.get('clf')).toBe(placement!.id);
    } finally {
      vi.useRealTimers();
    }
  });
'''

path.write_text(source.replace(marker, marker + tests, 1), encoding='utf-8')
