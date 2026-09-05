export type MultiDeviceErrorCode =
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
  | 'PAIRING_EXPIRED';

export class MultiDeviceError extends Error {
  constructor(public readonly code: MultiDeviceErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'MultiDeviceError';
  }
}
