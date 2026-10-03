import { Router, type IRouter } from "express";
import { getMe, updateMe } from "../controller/profile.controller.js";
import { limits } from "../middlware/rateLimit.js";

const router: IRouter = Router();

router.get("/", getMe);
router.patch("/", limits.profile, updateMe);

export default router;
