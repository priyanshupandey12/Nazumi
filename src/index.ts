import 'dotenv/config'
import express from "express";
import cors from "cors";
import { toNodeHandler,fromNodeHeaders  } from "better-auth/node";
import { auth } from './lib/auth.js';
import videoRoutes from './routes/video.routes.js';
import commentRoutes from './routes/comment.routes.js';
import creatorRoutes from './routes/creator.routes.js';
import { uploadErrorHandler } from './middlware/errors.js';


const app = express();


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


app.use(uploadErrorHandler);

app.listen(process.env.PORT, () => {
    console.log(`Server is running on port ${process.env.PORT}`);
});