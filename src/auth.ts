import type { SupabaseClient } from "@supabase/supabase-js";
import type { Request, Response, NextFunction } from "express";

// Expose the verified user id on the request for downstream handlers.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

/**
 * Build middleware that verifies a Supabase access token against a specific
 * project and attaches the trusted user id to req.userId.
 *
 * The token is validated server-side via supabase.auth.getUser() — we never
 * trust a client-supplied user id. Pass the SupabaseClient for the project that
 * issued the token (ledningssystem and boende are separate projects).
 */
export function createRequireUser(authClient: SupabaseClient) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;

    if (!token) {
      res.status(401).json({ error: "Missing bearer token" });
      return;
    }

    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data.user) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    req.userId = data.user.id;
    next();
  };
}
