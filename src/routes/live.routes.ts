import { Router, type IRouter } from "express";
import { authorizeStream } from "../controller/livestream.controller.js";

const router: IRouter = Router();

// Called by MediaMTX, not by a browser. Deliberately unauthenticated: the
// stream key in the path is the credential being checked.
router.post("/auth", authorizeStream);

export default router;
