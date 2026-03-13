import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const apiToken = process.env.API_TOKEN;

  if (!apiToken) {
    console.error('API_TOKEN environment variable is not set');
    res.status(500).json({ status: 'error', message: 'Server configuration error' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ status: 'error', message: 'Missing or invalid authorization token' });
    return;
  }

  const token = authHeader.slice(7);

  const tokenBuffer = Buffer.from(token);
  const apiTokenBuffer = Buffer.from(apiToken);

  if (tokenBuffer.length !== apiTokenBuffer.length || !crypto.timingSafeEqual(tokenBuffer, apiTokenBuffer)) {
    res.status(401).json({ status: 'error', message: 'Missing or invalid authorization token' });
    return;
  }

  next();
}
