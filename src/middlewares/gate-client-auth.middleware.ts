// Import Library
import type { NextFunction, Request, Response } from "express";
// Import Services
import { verifyGateClientCredentials } from "../services/shared/gate-client-auth.service";
// Import Utils
import ApiError from "../utils/api-error";

/* -------------------------------------- Functions -------------------------------------- */

// Function decode Basic credentials จาก Authorization header เป็น clientId และ clientSecret
function decodeBasicCredentials(authorization: string | undefined): {
  clientId: string;
  clientSecret: string;
} {
  if (!authorization || typeof authorization !== "string") {
    throw new ApiError(401, "GATE_AUTH_REQUIRED", "Gate client credentials are required.");
  }

  const match = authorization.match(/^Basic\s+(.+)$/i);

  if (!match?.[1]) {
    throw new ApiError(
      401,
      "INVALID_GATE_AUTH_SCHEME",
      "Gate authorization must use Basic credentials."
    );
  }

  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const separatorIndex = decoded.indexOf(":");

  if (separatorIndex <= 0) {
    throw new ApiError(
      401,
      "INVALID_GATE_CREDENTIALS",
      "Invalid Gate client credentials."
    );
  }

  const clientId = decoded.slice(0, separatorIndex).trim();
  const clientSecret = decoded.slice(separatorIndex + 1);

  if (!clientId || !clientSecret) {
    throw new ApiError(
      401,
      "INVALID_GATE_CREDENTIALS",
      "Invalid Gate client credentials."
    );
  }

  return {
    clientId,
    clientSecret,
  };
}

// Function จัดการ gate client auth middleware สำหรับ Express middleware
export default async function gateClientAuthMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const credentials = decodeBasicCredentials(req.headers.authorization);
    const gateClient = await verifyGateClientCredentials(
      credentials.clientId,
      credentials.clientSecret
    );

    if (!gateClient) {
      throw new ApiError(
        401,
        "INVALID_GATE_CREDENTIALS",
        "Invalid Gate client credentials."
      );
    }

    req.gateClient = gateClient;
    next();
  } catch (error) {
    next(error);
  }
}
