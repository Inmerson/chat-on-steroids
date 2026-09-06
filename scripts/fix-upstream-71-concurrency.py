from pathlib import Path

path = Path('src/main/bridge.ts')
source = path.read_text(encoding='utf-8')

old_next = '''/**
 * One at a time, whatever kind it is. The browser half can only be opening one tab anyway,
 * and a worker chat is identified by the extension reporting which tab it opened for which
 * slot — so two bootstraps in flight is precisely the state where that report can be made
 * about the wrong tab.
 */
function nextDeliverable(): Command | null {
  if (commandLeaseWrites.size > 0) return null;
  // Revivals never enter the app's browser opener: only the extension can know whether the exact
  // conversation is already open. They also must not block unrelated fresh worker/resume tabs.
  if (commands.some((command) => (command.spec.type === 'worker' || command.spec.type === 'resume') && isLeased(command))) return null;
  return commands.find((command) => command.spec.type === 'worker' || command.spec.type === 'resume') ?? null;
}
'''
new_next = '''/**
 * Serializes every OS-opened fresh chat and every resume, while allowing exact worker markers
 * already handed to a proven Prime browser to progress independently.
 *
 * The old global lease fence was necessary when a worker was identified only by which fresh tab
 * happened to report next. Fresh worker pages now redeem their own command id from the `clf`
 * marker, and Prime-side placement keeps one offer/timer per command. That makes those browser-
 * placed workers independent without weakening the OS fallback: a worker with no placement
 * offer still blocks the line exactly as before, so cold starts and default-browser opens never
 * stack.
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

if old_next not in source:
    raise SystemExit('nextDeliverable block not found')
source = source.replace(old_next, new_next, 1)

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
if old_offer not in source:
    raise SystemExit('offerPlacement delivery block not found')
source = source.replace(old_offer, new_offer, 1)

path.write_text(source, encoding='utf-8')
