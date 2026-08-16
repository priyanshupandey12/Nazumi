import 'dotenv/config'
import express from "express";
import { toNodeHandler,fromNodeHeaders  } from "better-auth/node";
import { auth } from './lib/auth.js';


const app = express();

app.all("/api/auth/*splat", toNodeHandler(auth));
app.use(express.json());

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

app.listen(process.env.PORT, () => {
    console.log(`Server is running on port ${process.env.PORT}`);
});