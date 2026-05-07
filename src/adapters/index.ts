export type { Adapter, AdapterContext, SyncErrorReason, SyncResult } from './types.js';
export { SyncError } from './types.js';
export type { AdapterRegistry } from './registry.js';
export { createAdapterRegistry } from './registry.js';
export type { CredentialsRow, TokenSet } from './credentials.js';
export { createAdapterCredentialsStore } from './credentials.js';
export type { RefreshFn } from './oauth.js';
export { refreshAccessTokenAtomic } from './oauth.js';
export type { AdapterState } from './state.js';
export { readState, writeStateError, writeStateSuccess } from './state.js';
export { buildFitbitAdapter } from './fitbit/index.js';
export {
  GOOGLE_HEALTH_CREDENTIALS_KEY,
  authConfigPath,
  loadGoogleHealthAuthConfig,
  saveGoogleHealthAuthConfig,
} from './googlehealth/auth-config.js';
export type { GoogleHealthAuthConfig } from './googlehealth/auth-config.js';
export { runGoogleHealthOAuthFlow } from './googlehealth/connect.js';
