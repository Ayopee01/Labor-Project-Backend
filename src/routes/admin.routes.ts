// Import Library
import express from "express";
// Import Middlewares
import authMiddleware from "../middlewares/auth.middleware";
import roleMiddleware from "../middlewares/role.middleware";
import sessionMiddleware from "../middlewares/session.middleware";
// Import Routes
import adminAuditRoutes from "./admin-audit.routes";
import adminJobRoutes from "./admin-jobs.routes";
import adminSettingsRoutes from "./admin-settings.routes";
import adminWorkersRoutes from "./admin-workers.routes";
import notificationRoutes from "./notifications.routes";

const router = express.Router();

/* -------------------------------------- Admin Routes -------------------------------------- */

// ตรวจ token, session และ role ครั้งเดียวต่อ request ก่อนเข้า router ย่อยของ Admin ทุกตัว
router.use(authMiddleware, sessionMiddleware, roleMiddleware(["admin"]));

router.use("/users", adminWorkersRoutes);
router.use(adminAuditRoutes);
router.use(adminSettingsRoutes);
router.use(adminJobRoutes);
router.use("/events", notificationRoutes);

export default router;
