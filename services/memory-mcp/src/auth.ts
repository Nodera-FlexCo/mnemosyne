import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';

export interface MnemoAuth {
  token: string;
  clientId: string;
  scopes: string[];
  extra: { projectId: string };
}

/**
 * Bearer auth. If MNEMO_TOKEN is unset the server runs open (intended for
 * localhost-only use where Claude Code reaches it over the loopback). When set,
 * a matching `Authorization: Bearer <token>` is required.
 *
 * Architected so swapping this static check for an OAuth TokenVerifier is a
 * one-file change (see revision §7.4).
 */
export function requireBearer(req: Request, res: Response, next: NextFunction): void {
  const auth: MnemoAuth = {
    token: 'local',
    clientId: 'local',
    scopes: ['memory'],
    extra: { projectId: config.defaultProjectId },
  };

  if (config.bearerToken) {
    const presented = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (presented !== config.bearerToken) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    auth.token = presented;
    auth.clientId = 'mnemo';
  }

  // threaded to tool handlers via extra.authInfo by the transport
  (req as Request & { auth?: MnemoAuth }).auth = auth;
  next();
}
