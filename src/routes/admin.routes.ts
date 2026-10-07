import { Router, type IRouter } from "express";
import {
  listUsers,
  setUserRole,
  listAllVideos,
  takedownVideo,
  restoreVideo,
} from "../controller/admin.controller.js";

const router: IRouter = Router();

router.get("/users", listUsers);
router.patch("/users/:id/role", setUserRole);

router.get("/videos", listAllVideos);
router.post("/videos/:id/takedown", takedownVideo);
router.post("/videos/:id/restore", restoreVideo);

export default router;
