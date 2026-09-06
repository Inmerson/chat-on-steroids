/**
 * The workspace joins recorded chat context with the existing read-only Agent
 * Control Center. It owns presentation navigation only; session selection and
 * orchestration authority remain in their current modules.
 */
export function initWorkspaceShell(
  root: ParentNode,
  actions: { openControl: () => void }
): void {
  const openControl = root.querySelector<HTMLButtonElement>('#workspaceOpenControl');
  openControl?.addEventListener('click', actions.openControl);
}
