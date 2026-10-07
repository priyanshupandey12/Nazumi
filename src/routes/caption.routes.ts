import { Router, type IRouter } from "express";
import {
  getCaptionFile,
  deleteCaption,
  setDefaultCaption,
} from "../controller/caption.controller.js";

const router: IRouter = Router();

// Captions are listed and created under their video; these address one track.
router.get("/:id/file", getCaptionFile);
router.post("/:id/default", setDefaultCaption);
router.delete("/:id", deleteCaption);

export default router;
