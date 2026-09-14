import ApiError from "./api-error";

/* -------------------------------------- Functions -------------------------------------- */

// Function ดึง Bearer token จาก Authorization header
export function extractBearerToken(
  authorization: string | undefined,
  errors: {
    missingCode: string;
    missingMessage: string;
    invalidCode: string;
    invalidMessage: string;
  }
): string {
  if (!authorization || typeof authorization !== "string") {
    throw new ApiError(401, errors.missingCode, errors.missingMessage);
  }

  const [scheme, token] = authorization.split(" ");

  if (scheme !== "Bearer" || !token) {
    throw new ApiError(401, errors.invalidCode, errors.invalidMessage);
  }

  return token;
}
