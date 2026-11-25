import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db, UserDoc } from '../db.js';

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32 || secret.startsWith('replace-with')) throw new Error('Set JWT_SECRET to a private random value of at least 32 characters.');
  return secret;
}

export interface AuthRequest extends Request {
  user?: UserDoc;
}

export function generateToken(user: UserDoc): string {
  return jwt.sign(
    {
      id: user._id,
      email: user.email,
      role: user.role,
      name: user.name,
      studentId: user.studentId,
    },
    jwtSecret(),
    { expiresIn: '7d' }
  );
}

export function authenticate(req: AuthRequest, res: Response, next: NextFunction): void {
  try {
    let token = req.cookies?.auth_token;
    
    // Also check Authorization header
    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      res.status(401).json({ error: 'Authentication required. Please log in.' });
      return;
    }

    const decoded = jwt.verify(token, jwtSecret()) as { id: string };
    const user = db.users.findById(decoded.id);

    if (!user || !user.isActive) {
      res.status(401).json({ error: 'User session expired or account deactivated.' });
      return;
    }

    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired authentication token.' });
  }
}

export function authorizeRoles(...allowedRoles: Array<'admin' | 'teacher' | 'student'>) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated.' });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        error: `Forbidden: role '${req.user.role}' does not have permission to perform this action.`,
      });
      return;
    }

    next();
  };
}
