import { Router, type IRouter } from "express";
import {
  getCreator,
  subscribe,
  unsubscribe,
} from "../controller/creator.controller.js";

const router: IRouter = Router();

router.get("/:id", getCreator);
router.post("/:id/subscribe", subscribe);
router.delete("/:id/subscribe", unsubscribe);

export default router;
