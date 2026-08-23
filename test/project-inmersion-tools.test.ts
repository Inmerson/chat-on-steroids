import { afterEach, describe, expect, it } from 'vitest';
import {
  allowedProgramNames,
  assertGitPathsSafe,
  configuredProjectInmersionRoot,
  normalizeRelativePath,
  projectInmersionRoot
} from '../src/main/mcp/tools-project-inmersion.js';

const ENV = 'CHAT_ON_STEROIDS_PROJECT_INMERSION_ROOT';
const original = process.env[ENV];

afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

describe('Project Inmersion profile security boundary', () => {
  it('uses the explicit local profile root override when present', () => {
    process.env[ENV] = 'C:\\Work\\Project Inmersion';
    expect(configuredProjectInmersionRoot()).toBe('C:\\Work\\Project Inmersion');
  });

  it('requires the fixed profile root to already be approved', () => {
    process.env[ENV] = 'C:\\Work\\Project Inmersion';
    expect(projectInmersionRoot([{ name: 'project-inmersion', path: 'C:\\Work\\Project Inmersion' }])).toEqual({
      name: 'project-inmersion',
      path: 'C:\\Work\\Project Inmersion'
    });
    expect(() => projectInmersionRoot([{ name: 'other', path: 'C:\\Work\\Other' }])).toThrow(/PROJECT_ROOT_NOT_APPROVED/);
  });

  it('accepts relative workspace paths and rejects traversal and absolute paths', () => {
    expect(normalizeRelativePath('Inmersion Game\\NeuroNode')).toBe('Inmersion Game/NeuroNode');
    expect(() => normalizeRelativePath('../outside')).toThrow(/traversal/i);
    expect(() => normalizeRelativePath('C:\\Windows')).toThrow(/absolute/i);
    expect(() => normalizeRelativePath('/etc')).toThrow(/absolute/i);
  });

  it('keeps shell_exec on a closed program allowlist', () => {
    expect(allowedProgramNames()).toEqual(['git', 'powershell', 'pwsh', 'unity']);
  });

  it('requires explicit safe git paths', () => {
    expect(assertGitPathsSafe(['src/app.ts', 'Assets/Editor/Test.cs'])).toEqual(['src/app.ts', 'Assets/Editor/Test.cs']);
    expect(() => assertGitPathsSafe(['--all'])).toThrow(/option/i);
    expect(() => assertGitPathsSafe(['../other'])).toThrow(/traversal/i);
  });
});