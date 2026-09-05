import { z } from 'zod';
import type { MultiDeviceErrorCode } from './errors.js';
import type { ProtocolOperation } from './types.js';

export const MULTIDEVICE_PROTOCOL_VERSION = 1 as const;

export interface ProtocolRequest {
  protocol_version: typeof MULTIDEVICE_PROTOCOL_VERSION;
  request_id: string;
  device_id: string;
  operation: ProtocolOperation;
  payload: unknown;
}

export type ProtocolResponse =
  | {
      protocol_version: typeof MULTIDEVICE_PROTOCOL_VERSION;
      request_id: string;
      ok: true;
      result: unknown;
      error: null;
    }
  | {
      protocol_version: typeof MULTIDEVICE_PROTOCOL_VERSION;
      request_id: string;
      ok: false;
      result: null;
      error: { code: MultiDeviceErrorCode; message: string };
    };

const protocolOperationSchema: z.ZodType<ProtocolOperation> = z.enum([
  'filesystem.read',
  'filesystem.apply_patch',
  'terminal.exec'
]);

const multiDeviceErrorCodeSchema: z.ZodType<MultiDeviceErrorCode> = z.enum([
  'DEVICE_NOT_FOUND',
  'DEVICE_OFFLINE',
  'DEVICE_REVOKED',
  'CAPABILITY_DENIED',
  'ROOT_DENIED',
  'PROTOCOL_MISMATCH',
  'REQUEST_TIMEOUT',
  'REQUEST_CANCELLED',
  'REMOTE_EXECUTION_FAILED',
  'INVALID_REQUEST',
  'TRANSPORT_UNAVAILABLE',
  'AUTHENTICATION_FAILED',
  'PAIRING_INVALID',
  'PAIRING_EXPIRED'
]);

const protocolRequestSchema: z.ZodType<ProtocolRequest> = z.object({
  protocol_version: z.literal(MULTIDEVICE_PROTOCOL_VERSION),
  request_id: z.string(),
  device_id: z.string(),
  operation: protocolOperationSchema,
  payload: z.unknown()
});

const protocolSuccessResponseSchema = z.object({
  protocol_version: z.literal(MULTIDEVICE_PROTOCOL_VERSION),
  request_id: z.string(),
  ok: z.literal(true),
  result: z.unknown(),
  error: z.null()
});

const protocolErrorResponseSchema = z.object({
  protocol_version: z.literal(MULTIDEVICE_PROTOCOL_VERSION),
  request_id: z.string(),
  ok: z.literal(false),
  result: z.null(),
  error: z.object({
    code: multiDeviceErrorCodeSchema,
    message: z.string()
  })
});

const protocolResponseSchema: z.ZodType<ProtocolResponse> = z.discriminatedUnion('ok', [
  protocolSuccessResponseSchema,
  protocolErrorResponseSchema
]);

export function parseProtocolRequest(value: unknown): ProtocolRequest {
  return protocolRequestSchema.parse(value);
}

export function parseProtocolResponse(value: unknown): ProtocolResponse {
  return protocolResponseSchema.parse(value);
}
