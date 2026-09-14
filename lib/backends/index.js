import { QoderBackend } from './qodercli.js';
import { CodexBackend } from './codex.js';

export const BACKENDS = {
  [QoderBackend.id]: QoderBackend,
  [CodexBackend.id]: CodexBackend,
};

export const PROVIDER_IDS = Object.keys(BACKENDS);
export const DEFAULT_PROVIDER = QoderBackend.id;

export function backendClass(id) {
  return BACKENDS[id] ?? BACKENDS[DEFAULT_PROVIDER];
}

export function createBackend(id, session) {
  const Backend = backendClass(id);
  return new Backend(session);
}

export function providerMeta(id) {
  const Backend = backendClass(id);
  return {
    id: Backend.id,
    label: Backend.label,
    persistent: Backend.persistent,
    streamsText: Backend.streamsText,
    supportsPermissionPrompts: Backend.supportsPermissionPrompts,
    binaryKey: Backend.binaryKey,
    defaultBinary: Backend.defaultBinary,
    defaultPermissionMode: Backend.defaultPermissionMode,
    permissionModes: Backend.permissionModes,
  };
}

export function allProviderMeta() {
  return PROVIDER_IDS.map(providerMeta);
}

export function validPermissionMode(providerId, mode) {
  return backendClass(providerId).permissionModes.some((entry) => entry.value === mode);
}
