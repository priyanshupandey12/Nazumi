import { Router, type IRouter } from "express";
import {
  listNotifications,
  getUnreadCount,
  markRead,
} from "../controller/notification.controller.js";

const router: IRouter = Router();

// Literal segments first so they are not read as ids.
router.get("/unread-count", getUnreadCount);
router.post("/read", markRead);
router.get("/", listNotifications);

export default router;
