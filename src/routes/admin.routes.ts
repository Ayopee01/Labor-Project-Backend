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
// Import Utils
import { createRouter } from "../utils/http";

const router = createRouter();

/* -------------------------------------- Admin Routes -------------------------------------- */

// ตรวจ token, session และ role ครั้งเดียวต่อ request ก่อนเข้า router ย่อยของ Admin ทุกตัว
router.use(authMiddleware);
router.use(sessionMiddleware);
router.use(roleMiddleware(["admin"]));

router.route("/users", adminWorkersRoutes);
router.route("/", adminAuditRoutes);
router.route("/", adminSettingsRoutes);
router.route("/", adminJobRoutes);
router.route("/events", notificationRoutes);

export default router;
