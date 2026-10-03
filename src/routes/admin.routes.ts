import { Router, type IRouter } from "express";
import { listUsers, setUserRole } from "../controller/admin.controller.js";

const router: IRouter = Router();

router.get("/users", listUsers);
router.patch("/users/:id/role", setUserRole);

export default router;
