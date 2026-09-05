import { describe, expect, expectTypeOf, it } from 'vitest';
import { MultiDeviceError, type MultiDeviceErrorCode } from '../src/shared/multidevice/errors.js';
import {
  MULTIDEVICE_PROTOCOL_VERSION,
  parseProtocolRequest,
  parseProtocolResponse,
  type ProtocolRequest,
  type ProtocolResponse
} from '../src/shared/multidevice/protocol.js';
import type {
  DeviceCapability,
  DeviceId,
  DeviceStatus,
  ProtocolOperation
} from '../src/shared/multidevice/types.js';

describe('multi-device protocol', () => {
  it('defines the exact canonical domain string unions', () => {
    expectTypeOf<DeviceId>().toEqualTypeOf<string>();
    expectTypeOf<DeviceCapability>().toEqualTypeOf<
      'filesystem.read' | 'filesystem.write' | 'terminal.exec'
    >();
    expectTypeOf<DeviceStatus>().toEqualTypeOf<
      'UNENROLLED' | 'CONNECTING' | 'ONLINE' | 'DEGRADED' | 'OFFLINE' | 'REVOKED'
    >();
    expectTypeOf<ProtocolOperation>().toEqualTypeOf<
      'filesystem.read' | 'filesystem.apply_patch' | 'terminal.exec'
    >();
    expectTypeOf<MultiDeviceErrorCode>().toEqualTypeOf<
      | 'DEVICE_NOT_FOUND'
      | 'DEVICE_OFFLINE'
      | 'DEVICE_REVOKED'
      | 'CAPABILITY_DENIED'
      | 'ROOT_DENIED'
      | 'PROTOCOL_MISMATCH'
      | 'REQUEST_TIMEOUT'
      | 'REQUEST_CANCELLED'
      | 'REMOTE_EXECUTION_FAILED'
      | 'INVALID_REQUEST'
      | 'TRANSPORT_UNAVAILABLE'
      | 'AUTHENTICATION_FAILED'
      | 'PAIRING_INVALID'
      | 'PAIRING_EXPIRED'
    >();
  });

  it('uses protocol version 1', () => {
    expect(MULTIDEVICE_PROTOCOL_VERSION).toBe(1);
  });

  it('accepts an explicit device-scoped terminal request', () => {
    const parsed = parseProtocolRequest({
      protocol_version: MULTIDEVICE_PROTOCOL_VERSION,
      request_id: 'req_123',
      device_id: 'dev_123',
      operation: 'terminal.exec',
      payload: { cmd: 'whoami', timeout_ms: 30_000 }
    });

    expect(parsed.device_id).toBe('dev_123');
    expect(parsed.operation).toBe('terminal.exec');
    expectTypeOf(parsed).toEqualTypeOf<ProtocolRequest>();
  });

  it('keeps request payload unknown at the envelope level', () => {
    const parsed = parseProtocolRequest({
      protocol_version: MULTIDEVICE_PROTOCOL_VERSION,
      request_id: 'req_payload',
      device_id: 'dev_123',
      operation: 'filesystem.read',
      payload: 'executor-validates-this'
    });

    expect(parsed.payload).toBe('executor-validates-this');
  });

  it('rejects a request without device_id', () => {
    expect(() =>
      parseProtocolRequest({
        protocol_version: MULTIDEVICE_PROTOCOL_VERSION,
        request_id: 'req_123',
        operation: 'terminal.exec',
        payload: { cmd: 'whoami' }
      })
    ).toThrow();
  });

  it('rejects unsupported protocol versions and operations', () => {
    expect(() =>
      parseProtocolRequest({
        protocol_version: 2,
        request_id: 'req_version',
        device_id: 'dev_123',
        operation: 'terminal.exec',
        payload: null
      })
    ).toThrow();

    expect(() =>
      parseProtocolRequest({
        protocol_version: MULTIDEVICE_PROTOCOL_VERSION,
        request_id: 'req_operation',
        device_id: 'dev_123',
        operation: 'filesystem.write',
        payload: null
      })
    ).toThrow();
  });

  it('parses a stable structured error response', () => {
    const parsed = parseProtocolResponse({
      protocol_version: MULTIDEVICE_PROTOCOL_VERSION,
      request_id: 'req_123',
      ok: false,
      result: null,
      error: { code: 'DEVICE_OFFLINE', message: 'Device is offline' }
    });

    expect(parsed.ok).toBe(false);
    expectTypeOf(parsed).toEqualTypeOf<ProtocolResponse>();
  });

  it('parses a success response with an unknown result', () => {
    const parsed = parseProtocolResponse({
      protocol_version: MULTIDEVICE_PROTOCOL_VERSION,
      request_id: 'req_success',
      ok: true,
      result: ['executor', 'owns', 'shape'],
      error: null
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.result).toEqual(['executor', 'owns', 'shape']);
  });

  it('rejects error responses outside the canonical error-code set', () => {
    expect(() =>
      parseProtocolResponse({
        protocol_version: MULTIDEVICE_PROTOCOL_VERSION,
        request_id: 'req_bad_error',
        ok: false,
        result: null,
        error: { code: 'UNKNOWN_ERROR', message: 'Unknown' }
      })
    ).toThrow();
  });

  it('provides the canonical MultiDeviceError shape', () => {
    const error = new MultiDeviceError('DEVICE_OFFLINE', 'Device is offline');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MultiDeviceError');
    expect(error.code).toBe('DEVICE_OFFLINE');
    expect(error.message).toBe('DEVICE_OFFLINE: Device is offline');
  });
});
