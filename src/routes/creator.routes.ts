import { Router, type IRouter } from "express";
import {
  getCreator,
  subscribe,
  unsubscribe,
} from "../controller/creator.controller.js";
import { limits } from "../middlware/rateLimit.js";

const router: IRouter = Router();

router.get("/:id", getCreator);
router.post("/:id/subscribe", limits.subscribe, subscribe);
router.delete("/:id/subscribe", limits.subscribe, unsubscribe);

export default router;
