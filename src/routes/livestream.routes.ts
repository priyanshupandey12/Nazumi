import { Router, type IRouter } from "express";
import {
  listMyStreams,
  createStream,
  updateStream,
  rotateKey,
  deleteStream,
  listLive,
  getStream,
  recordStreamView,
} from "../controller/livestream.controller.js";
import { limits } from "../middlware/rateLimit.js";

const router: IRouter = Router();

// Literal segments first so they are not read as ids.
router.get("/live", listLive);
router.get("/mine", listMyStreams);

router.post("/", createStream);
router.get("/:id", getStream);
router.patch("/:id", updateStream);
router.delete("/:id", deleteStream);
router.post("/:id/key", rotateKey);
router.post("/:id/view", limits.view, recordStreamView);

export default router;
