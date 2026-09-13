import { Router, type IRouter } from "express";
import { deleteComment } from "../controller/comment.controller.js";

const router: IRouter = Router();

// Comments are read and written under their video; only removal addresses a
// comment directly, because the caller already has its id.
router.delete("/:id", deleteComment);

export default router;
