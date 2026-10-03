import { Router, type IRouter } from "express";
import {
  createReport,
  listReports,
  resolveReport,
  openReportCount,
} from "../controller/report.controller.js";
import { limits } from "../middlware/rateLimit.js";

const router: IRouter = Router();

// Literal segments first so they are not read as ids.
router.get("/open-count", openReportCount);
router.get("/", listReports);
router.post("/", limits.report, createReport);
router.post("/:id/resolve", resolveReport);

export default router;
