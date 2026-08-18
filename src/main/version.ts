/**
 * Version constants shared by the app, the bridge and the Chrome extension.
 *
 * `APP_VERSION` is written here rather than imported from package.json so the bundled
 * main process does not have to reach outside its own build. A test asserts that this
 * constant, package.json and extension/manifest.json all agree, so a release cannot ship
 * an extension that silently disagrees with the app it pairs to.
 *
 * `BRIDGE_PROTOCOL` is what actually has to match. It moves only when the request or
 * response shape between app and extension changes in a way an older peer cannot handle,
 * which is far less often than the app's own version moves — and it is what turns "the
 * extension does nothing" into a diagnosable mismatch.
 */

export const APP_VERSION = '1.7.6';

/**
 * 1 — original observations/activity bridge.
 * 2 — leased commands: /commands hands out a claim, /commands/ack reports the outcome.
 * 3 — browser-triggered compaction via /compact and worker bootstrap completion semantics.
 * 4 — targeted open: the app opens the chat itself with a ?clf=<id> marker and the page
 *     redeems that one id through /commands/redeem, /commands also reports which ids are
 *     still active, /activity carries the resume job and compaction progress, and /pair
 *     provisions silently.
 */
export const BRIDGE_PROTOCOL = 4;
