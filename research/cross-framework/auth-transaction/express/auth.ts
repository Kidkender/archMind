import jwt from 'jsonwebtoken'
import type { Request, Response, NextFunction } from 'express'

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    (req as any).user = jwt.verify(req.headers.authorization ?? '', process.env.JWT_SECRET!)
    next()
  } catch {
    res.status(401).end()
  }
}
