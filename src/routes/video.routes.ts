import { Router, type IRouter } from "express";
import upload from "../middlware/multer.js";
import { uploadVideo, getVideoStatus } from "../controller/video.controller.js";

const router: IRouter = Router();

router.post("/", upload.single("video"), uploadVideo);
router.get("/:id/status", getVideoStatus);

export default router;
