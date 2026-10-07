import { Router, type IRouter } from "express";
import upload from "../middlware/multer.js";
import { limits } from "../middlware/rateLimit.js";
import { likeVideo, unlikeVideo } from "../controller/like.controller.js";
import { listComments, createComment } from "../controller/comment.controller.js";
import { listCaptions, createCaption } from "../controller/caption.controller.js";
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
  getVideoThumbnails,
} from "../controller/video.controller.js";

const router: IRouter = Router();

router.post("/", limits.upload, upload.single("video"), uploadVideo);
router.get("/", getAllVideo);

router.get("/categories", getCategories);
router.get("/mine", getAllUploadedVideo);
router.get("/mine/:id", getUploadedVideoById);
router.get("/:id/status", getVideoStatus);
router.get("/:id/related", getRelatedVideos);
router.get("/:id/thumbnails", getVideoThumbnails);

router.get("/:id/captions", listCaptions);
router.post("/:id/captions", createCaption);
router.post("/:id/view", limits.view, recordVideoView);

router.post("/:id/like", limits.like, likeVideo);
router.delete("/:id/like", limits.like, unlikeVideo);

router.get("/:id/comments", listComments);
router.post("/:id/comments", limits.comment, createComment);

router.get("/:id", getVideoById);
router.patch("/:id", updateVideo);
router.delete("/:id", deleteVideo);

export default router;
