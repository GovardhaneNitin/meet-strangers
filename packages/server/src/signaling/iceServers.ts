import { createHmac, randomBytes } from 'node:crypto';
import type { IceServer } from '@meet-strangers/shared';
import type { Config } from '../config.js';

/**
 * Build the ICE server list for one chat.
 *
 * TURN credentials are never static: they follow the TURN REST API scheme
 * supported by coturn (`use-auth-secret`). The username embeds an expiry
 * timestamp and the password is an HMAC of it, so leaked credentials stop
 * working after the TTL and the shared secret never leaves the server.
 */
export function buildIceServers(
  config: Pick<Config, 'STUN_URLS' | 'TURN_URLS' | 'TURN_SECRET' | 'TURN_CREDENTIAL_TTL_SECONDS'>,
  now: number = Date.now(),
): IceServer[] {
  const servers: IceServer[] = [];
  if (config.STUN_URLS.length > 0) servers.push({ urls: config.STUN_URLS });

  if (config.TURN_URLS.length > 0 && config.TURN_SECRET) {
    const expiresAt = Math.floor(now / 1000) + config.TURN_CREDENTIAL_TTL_SECONDS;
    const username = `${expiresAt}:${randomBytes(8).toString('hex')}`;
    const credential = createHmac('sha1', config.TURN_SECRET).update(username).digest('base64');
    servers.push({ urls: config.TURN_URLS, username, credential });
  }
  return servers;
}
