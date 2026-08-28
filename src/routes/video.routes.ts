import { Router, type IRouter } from "express";
import upload from "../middlware/multer.js";
import {
  uploadVideo,
  getVideoStatus,
  getAllVideo,
  getVideoById,
  getAllUploadedVideo,
  getUploadedVideoById,
  updateVideo,
  recordVideoView,
} from "../controller/video.controller.js";

const router: IRouter = Router();

router.post("/", upload.single("video"), uploadVideo);
router.get("/", getAllVideo);
router.get("/mine", getAllUploadedVideo);
router.get("/mine/:id", getUploadedVideoById);
router.get("/:id/status", getVideoStatus);
router.post("/:id/view", recordVideoView);
router.get("/:id", getVideoById);
router.patch("/:id", updateVideo);

export default router;
