/**
 * The tunnel client's own log lines are the only honest signal about whether
 * this PC can still reach OpenAI: its /readyz endpoint is a local check and
 * stays green through an internet outage. These tests pin the classifier that
 * turns those lines into a status the UI can show.
 */

import { describe, expect, it } from 'vitest';
import { ago, parseClientStatus, parsePollHealth, readMetric } from '../src/main/tunnel/health.js';
import { describeNetworkError, isUnreachableError } from '../src/main/tunnel/index.js';

/** Verbatim lines seen in the field, with the tunnel up and the WLAN off. */
const REAL_OUTAGE_LINES = [
  'poll failed; backing off',
  'Post "https://api.openai.com/v1/tunnels/poll": dial tcp: lookup api.openai.com: no such host',
  'read tcp 192.168.0.24:51544->104.18.32.115:443: wsarecv: An established connection was aborted by the software in your host machine',
  'dial tcp 104.18.32.115:443: i/o timeout',
  'connection refused',
  'network is unreachable'
];

describe('network error classification', () => {
  it('recognises every outage line the client actually printed', () => {
    for (const line of REAL_OUTAGE_LINES) {
      expect(isUnreachableError(line), line).toBe(true);
    }
  });

  it('leaves unrelated warnings alone', () => {
    // These must not flip the UI to offline: the tunnel is reachable, something
    // else is wrong, and mislabelling would send the user chasing their router.
    expect(isUnreachableError('WARN config reload skipped')).toBe(false);
    expect(isUnreachableError('ERROR unauthorized: invalid api key')).toBe(false);
    expect(isUnreachableError('tunnel not found')).toBe(false);
  });

  it('explains the cause in words a non-engineer can act on', () => {
    expect(describeNetworkError('lookup api.openai.com: no such host')).toBe(
      'no internet connection'
    );
    expect(describeNetworkError('wsarecv: An established connection was aborted')).toBe(
      'the connection dropped'
    );
    expect(describeNetworkError('dial tcp: connection refused')).toBe(
      'the connection was refused'
    );
    expect(describeNetworkError('dial tcp: i/o timeout')).toBe('the connection timed out');
    expect(describeNetworkError('network is unreachable')).toBe('the network is unreachable');
    expect(describeNetworkError('something odd happened')).toBe('a network error');
  });

  it('never leaks the raw error text into the explanation', () => {
    // The detail string is rendered in the UI; keeping it a fixed vocabulary
    // means a hostname, IP or port from the log can never end up on screen.
    for (const line of REAL_OUTAGE_LINES) {
      const said = describeNetworkError(line);
      expect(said).not.toMatch(/\d/);
      expect(said.length).toBeLessThan(40);
    }
  });
});

/**
 * Verbatim excerpt of a live /metrics response from tunnel-client 0.0.11, including
 * the label sets it really emits. Parsing has to survive these exactly.
 */
const METRICS = `# HELP commands_poll_cycles_total Total number of poll cycles initiated by the poller.
# TYPE commands_poll_cycles_total counter
commands_poll_cycles_total{otel_scope_name="controlplane",otel_scope_schema_url="",otel_scope_version=""} 35
# HELP commands_poll_errors_total Total number of control-plane poll errors encountered.
# TYPE commands_poll_errors_total counter
commands_poll_errors_total{error_kind="other",otel_scope_name="controlplane"} 9
commands_poll_errors_total{error_kind="host_unreachable",otel_scope_name="controlplane"} 4
# HELP commands_poll_last_successful_timestamp_seconds Unix timestamp in seconds of the last successful poll.
# TYPE commands_poll_last_successful_timestamp_seconds gauge
commands_poll_last_successful_timestamp_seconds{otel_scope_name="controlplane"} 1.786783114e+09
commands_poll_latency_seconds_count{error="false",otel_scope_name="controlplane"} 25
`;

describe('tunnel poll metrics', () => {
  it('adds up every label set of a counter', () => {
    // Poll errors are split by error_kind; reading only the first sample would
    // report 9 instead of 13 and understate how badly the link is doing.
    expect(readMetric(METRICS, 'commands_poll_errors_total')).toBe(13);
    expect(readMetric(METRICS, 'commands_poll_cycles_total')).toBe(35);
  });

  it('does not confuse a metric with one whose name it prefixes', () => {
    // `commands_poll_cycles` is a legitimate alternative name in older builds, and
    // must not silently pick up `commands_poll_cycles_total`.
    expect(readMetric(METRICS, 'commands_poll_cycles')).toBeNull();
    expect(readMetric(METRICS, 'commands_poll_latency_seconds')).toBeNull();
  });

  it('reads the last successful poll as a millisecond timestamp', () => {
    const health = parsePollHealth(METRICS);
    expect(health.lastSuccessMs).toBe(1786783114000);
    expect(health.errors).toBe(13);
  });

  it('reports never-succeeded as null rather than 1970', () => {
    const health = parsePollHealth(
      'commands_poll_last_successful_timestamp_seconds{a="b"} 0\ncommands_poll_cycles_total{a="b"} 3\n'
    );
    expect(health.lastSuccessMs).toBeNull();
    expect(health.polls).toBe(3);
  });

  it('survives a metrics page that has none of the fields', () => {
    const health = parsePollHealth('# nothing here\n');
    expect(health).toEqual({ lastSuccessMs: null, polls: null, errors: null });
  });
});

describe('tunnel client status', () => {
  it('picks the main channel probe and the control-plane error', () => {
    const status = parseClientStatus({
      version: '0.0.11',
      uptime_seconds: 833,
      channels: [
        { name: 'harpoon', enabled: false, probe_status: 'skipped' },
        { name: 'main', enabled: true, probe_status: 'ok' }
      ],
      tunnel_metadata_error: 'dial tcp: lookup api.openai.com: no such host'
    });
    expect(status.probe).toBe('ok');
    expect(status.version).toBe('0.0.11');
    expect(status.uptimeSeconds).toBe(833);
    expect(status.metadataError).toContain('no such host');
  });

  it('reports unknown rather than guessing when fields are missing', () => {
    expect(parseClientStatus({})).toEqual({
      version: null,
      probe: null,
      metadataError: null,
      uptimeSeconds: null,
      route: null
    });
    expect(parseClientStatus(null).probe).toBeNull();
    expect(parseClientStatus('not an object').probe).toBeNull();
  });

  it('names the proxy when there is one, and the mode when there is not', () => {
    expect(
      parseClientStatus({
        control_plane_route: { target: 'api.openai.com:443', route_mode: 'direct', proxy_source: 'none' }
      }).route
    ).toBe('api.openai.com:443 · direct');

    expect(
      parseClientStatus({
        control_plane_route: { target: 'api.openai.com:443', route_mode: 'proxy', proxy_source: 'HTTPS_PROXY' }
      }).route
    ).toBe('api.openai.com:443 · via HTTPS_PROXY');

    // No target means we know nothing, and say so rather than inventing a host.
    expect(parseClientStatus({ control_plane_route: { route_mode: 'direct' } }).route).toBeNull();
  });
});

describe('ago', () => {
  const now = 1_000_000_000_000;

  it('describes ages the way a person would', () => {
    expect(ago(null, now)).toBe('never');
    expect(ago(now - 1_000, now)).toBe('just now');
    expect(ago(now - 12_000, now)).toBe('12s ago');
    expect(ago(now - 5 * 60_000, now)).toBe('5m ago');
    expect(ago(now - 3 * 3_600_000, now)).toBe('3h ago');
  });

  it('never reports a negative age from a clock skew', () => {
    expect(ago(now + 60_000, now)).toBe('just now');
  });
});
