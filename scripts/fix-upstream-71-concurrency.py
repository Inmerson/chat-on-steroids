from pathlib import Path

path = Path('src/main/bridge.ts')
source = path.read_text(encoding='utf-8')


def function_range(text: str, signature: str) -> tuple[int, int]:
    function_at = text.index(signature)
    start = text.rfind('/**', 0, function_at)
    if start < 0 or function_at - start > 1500:
        start = function_at
    brace = text.index('{', function_at)
    depth = 0
    for index in range(brace, len(text)):
        char = text[index]
        if char == '{':
            depth += 1
        elif char == '}':
            depth -= 1
            if depth == 0:
                end = index + 1
                if end < len(text) and text[end] == '\n':
                    end += 1
                return start, end
    raise SystemExit(f'unclosed function: {signature}')


new_next = '''/**
 * Serializes every OS-opened fresh chat and every resume, while allowing exact worker markers
 * already handed to a proven Prime browser to progress independently.
 *
 * Fresh worker pages redeem their own command id from the `clf` marker, and Prime-side placement
 * keeps one offer/timer per command. Those browser-placed workers can therefore overlap safely.
 * A worker with no placement offer still blocks the line exactly as before, so cold starts and
 * default-browser opens never stack; resumes also remain one-at-a-time.
 */
function nextDeliverable(): Command | null {
  if (commandLeaseWrites.size > 0) return null;
  const blocked = commands.some((command) => {
    if (command.spec.type !== 'worker' && command.spec.type !== 'resume') return false;
    if (!isLeased(command)) return false;
    return command.spec.type === 'resume' || !placementOffers.has(command.id);
  });
  if (blocked) return null;
  return commands.find(
    (command) =>
      (command.spec.type === 'worker' || command.spec.type === 'resume') && !isLeased(command)
  ) ?? null;
}
'''

start, end = function_range(source, 'function nextDeliverable(): Command | null')
source = source[:start] + new_next + source[end:]

old_offer = '''  if (offerPlacement(command)) return;
  await openFreshChatInBrowser(command);
'''
new_offer = '''  if (offerPlacement(command)) {
    // Prime-side worker placement is command-id isolated. Advance the queue now so a single
    // agents spawn may hand every fresh worker to the same live Prime without waiting for the
    // first tab to redeem. Resumes remain serialized by nextDeliverable().
    if (command.spec.type === 'worker') void deliver();
    return;
  }
  await openFreshChatInBrowser(command);
'''
if source.count(old_offer) != 1:
    raise SystemExit(f'offerPlacement delivery block matches: {source.count(old_offer)}')
source = source.replace(old_offer, new_offer, 1)

path.write_text(source, encoding='utf-8')
