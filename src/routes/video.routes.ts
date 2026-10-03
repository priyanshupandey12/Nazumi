import { Router, type IRouter } from "express";
import upload from "../middlware/multer.js";
import { likeVideo, unlikeVideo } from "../controller/like.controller.js";
import { listComments, createComment } from "../controller/comment.controller.js";
import {
  uploadVideo,
  getVideoStatus,
  getAllVideo,
  getVideoById,
  getAllUploadedVideo,
  getUploadedVideoById,
  updateVideo,
  recordVideoView,
  deleteVideo,
  getCategories,
  getRelatedVideos,
} from "../controller/video.controller.js";

const router: IRouter = Router();

router.post("/", upload.single("video"), uploadVideo);
router.get("/", getAllVideo);

router.get("/categories", getCategories);
router.get("/mine", getAllUploadedVideo);
router.get("/mine/:id", getUploadedVideoById);
router.get("/:id/status", getVideoStatus);
router.get("/:id/related", getRelatedVideos);
router.post("/:id/view", recordVideoView);

router.post("/:id/like", likeVideo);
router.delete("/:id/like", unlikeVideo);

router.get("/:id/comments", listComments);
router.post("/:id/comments", createComment);

router.get("/:id", getVideoById);
router.patch("/:id", updateVideo);
router.delete("/:id", deleteVideo);

export default router;
