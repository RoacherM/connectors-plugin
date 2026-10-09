import { PREFERRED_PORT } from './oauth.js';

/** Plugin config (all optional): `dataDir` for connectors.json, `oauthCallbackPort` for the loopback redirect. */
export function callbackPort(config) {
  const port = Number(config?.oauthCallbackPort);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : PREFERRED_PORT;
}
