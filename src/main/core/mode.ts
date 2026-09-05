export type RuntimeMode =
  | { kind: 'ui' }
  | { kind: 'core-host'; userDataDir: string }
  | { kind: 'core-supervisor'; userDataDir: string };

export function parseRuntimeMode(argv: string[] = process.argv): RuntimeMode {
  const coreHost = argv.includes('--core-host');
  const supervisor = argv.includes('--core-supervisor');
  if (coreHost && supervisor) throw new Error('Only one Core helper mode may be selected');
  if (!coreHost && !supervisor) return { kind: 'ui' };

  const at = argv.indexOf('--core-user-data');
  const userDataDir = at >= 0 ? argv[at + 1]?.trim() : '';
  if (!userDataDir) throw new Error('Core helper mode requires --core-user-data');
  return coreHost
    ? { kind: 'core-host', userDataDir }
    : { kind: 'core-supervisor', userDataDir };
}
