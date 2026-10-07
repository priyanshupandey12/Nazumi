import 'dotenv/config'
import express, { type Express } from "express";
import cors from "cors";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import { auth } from './lib/auth.js';
import videoRoutes from './routes/video.routes.js';
import commentRoutes from './routes/comment.routes.js';
import creatorRoutes from './routes/creator.routes.js';
import notificationRoutes from './routes/notification.routes.js';
import profileRoutes from './routes/profile.routes.js';
import reportRoutes from './routes/report.routes.js';
import adminRoutes from './routes/admin.routes.js';
import captionRoutes from './routes/caption.routes.js';
import livestreamRoutes from './routes/livestream.routes.js';
import liveRoutes from './routes/live.routes.js';
import { uploadErrorHandler } from './middlware/errors.js';

/**
 * Builds the Express app without binding a port, so tests can drive it
 * in-process through supertest while `index.ts` owns the listening.
 */
export const createApp = (): Express => {
  const app = express();

  // Rate limiting keys anonymous callers by address, which is only correct
  // once Express trusts the proxy that set X-Forwarded-For.
  app.set("trust proxy", 1);

  const allowedOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
    }),
  );

  app.all("/api/auth/*splat", toNodeHandler(auth));

  app.use(express.json({ limit: "10mb" }));

  app.use("/api/videos", videoRoutes);
  app.use("/api/comments", commentRoutes);
  app.use("/api/creators", creatorRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/me", profileRoutes);
  app.use("/api/reports", reportRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/captions", captionRoutes);
  app.use("/api/livestreams", livestreamRoutes);
  app.use("/api/live", liveRoutes);

  app.get("/api/health", (req: express.Request, res: express.Response) => {
    res.json({ status: "healthy", timestamp: new Date() });
  });

  app.get("/api/protected-test", async (req: express.Request, res: express.Response) => {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session) {
      return res.status(401).json({ error: "Unauthorized - Please sign in first" });
    }
    res.json({
      message: "Success! You are authenticated.",
      user: session.user,
      session: session.session,
    });
  });

  // Last, so it sees anything the routes above throw.
  app.use(uploadErrorHandler);

  return app;
};
