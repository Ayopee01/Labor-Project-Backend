// Import Library
import { Prisma, type MasterProduct, type MasterRate } from "@prisma/client";
// Import Repositories
import * as masterDataRepository from "../../repositories/shared/master-data.repository";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
// Import Utils
import ApiError from "../../utils/api-error";
import { decimalToWeightString, packageWeightToDecimal } from "../../utils/labor-job-pricing";

/* -------------------------------------- Types -------------------------------------- */

// Type ผลการหา PackageWeight ของสินค้า
export type ResolvedPackageWeight = {
  packageWeight: Prisma.Decimal;
  packageName: string;
  // PACKAGE_FALLBACK = ยืม PackageWeight จากสินค้าอื่นที่ PackageCode เดียวกัน
  resolvedVia: "SPECIFIC_PRODUCT_PACKAGE" | "PACKAGE_FALLBACK";
};

/* -------------------------------------- Functions -------------------------------------- */

// Function เลือก candidate แถวแรกถ้า PackageWeight เท่ากันทุกแถว (ถ้าต่างกัน throw เพราะกำกวม)
function resolveDeterministicCandidate<
  T extends { packageWeight: number }
>(candidates: T[], ambiguousErrorCode: string, context: Record<string, unknown>): T {
  const distinctWeights = new Set(candidates.map((candidate) => candidate.packageWeight));

  if (distinctWeights.size > 1) {
    throw new ApiError(
      409,
      ambiguousErrorCode,
      "Matched more than one active product with conflicting package weights.",
      {
        ...context,
        matched_count: candidates.length,
        conflicting_weights: [...distinctWeights],
      }
    );
  }

  // ทุกแถว PackageWeight เท่ากัน ใช้แถวแรกตามลำดับ id asc ที่ repository query มา (deterministic)
  return candidates[0];
}

// Function หา master product ที่ตรงทั้ง ProductCode + PackageCode (ใช้ตอน Gate สร้าง Ticket ไม่มี fallback)
export async function requireActiveMasterProduct(
  productCode: string,
  packageCode: string,
  connection?: DbConnection
): Promise<MasterProduct> {
  const products =
    await masterDataRepository.listActiveProductsByProductCodeAndPackageCode(
      productCode,
      packageCode,
      connection
    );

  if (products.length === 0) {
    throw new ApiError(
      409,
      "PRODUCT_PACKAGE_NOT_FOUND",
      "Active product package was not found.",
      {
        productCode,
        packageCode,
      }
    );
  }

  if (products.length === 1) {
    return products[0];
  }

  return resolveDeterministicCandidate(products, "AMBIGUOUS_PRODUCT_PACKAGE", {
    productCode,
    packageCode,
  });
}

// Function หา PackageWeight สำหรับหา Rate (fallback ด้วย PackageCode ได้) ใช้ตอน Worker เปลี่ยน PackageCode
export async function resolvePackageWeight(
  productCode: string,
  packageCode: string,
  connection?: DbConnection
): Promise<ResolvedPackageWeight> {
  const specificProducts =
    await masterDataRepository.listActiveProductsByProductCodeAndPackageCode(
      productCode,
      packageCode,
      connection
    );

  if (specificProducts.length > 0) {
    const resolved =
      specificProducts.length === 1
        ? specificProducts[0]
        : resolveDeterministicCandidate(
            specificProducts,
            "AMBIGUOUS_PRODUCT_PACKAGE",
            { productCode, packageCode }
          );

    return {
      packageWeight: packageWeightToDecimal(resolved.packageWeight),
      packageName: resolved.packageName,
      resolvedVia: "SPECIFIC_PRODUCT_PACKAGE",
    };
  }

  const fallbackProducts = await masterDataRepository.listActiveProductsByPackageCode(
    packageCode,
    connection
  );

  if (fallbackProducts.length === 0) {
    throw new ApiError(
      409,
      "PRODUCT_PACKAGE_NOT_FOUND",
      "Active product package was not found.",
      {
        productCode,
        packageCode,
      }
    );
  }

  const resolvedFallback =
    fallbackProducts.length === 1
      ? fallbackProducts[0]
      : resolveDeterministicCandidate(
          fallbackProducts,
          "AMBIGUOUS_PACKAGE_WEIGHT",
          { productCode, packageCode }
        );

  return {
    packageWeight: packageWeightToDecimal(resolvedFallback.packageWeight),
    packageName: resolvedFallback.packageName,
    resolvedVia: "PACKAGE_FALLBACK",
  };
}

// Function หา rate ตามตลาดและน้ำหนักสินค้า
export async function requireApplicableRate(
  marketCode: string,
  packageWeight: Prisma.Decimal,
  connection?: DbConnection
): Promise<{
  rate: MasterRate;
  requestedMarketCode: string;
  appliedMarketCode: string;
  rateSource: "MARKET_RATE" | "CENTRAL_RATE";
}> {
  const marketRates =
    await masterDataRepository.listActiveRatesByMarketAndWeight(
      marketCode,
      packageWeight,
      connection
    );

  if (marketRates.length > 1) {
    throw new ApiError(
      409,
      "DUPLICATE_RATE_CONFIGURATION",
      "More than one active rate matched this market and package weight.",
      {
        marketCode,
        packageWeight: decimalToWeightString(packageWeight),
      }
    );
  }

  if (marketRates.length === 1) {
    return {
      rate: marketRates[0],
      requestedMarketCode: marketCode,
      appliedMarketCode: marketRates[0].marketCode,
      rateSource: "MARKET_RATE",
    };
  }

  const centralRates =
    await masterDataRepository.listActiveRatesByMarketAndWeight(
      "0000",
      packageWeight,
      connection
    );

  if (centralRates.length > 1) {
    throw new ApiError(
      409,
      "DUPLICATE_RATE_CONFIGURATION",
      "More than one active central rate matched this package weight.",
      {
        marketCode: "0000",
        packageWeight: decimalToWeightString(packageWeight),
      }
    );
  }

  if (centralRates.length === 0) {
    throw new ApiError(
      409,
      "RATE_NOT_FOUND",
      "No active rate matched this market or central rate.",
      {
        requestedMarketCode: marketCode,
        fallbackMarketCode: "0000",
        packageWeight: decimalToWeightString(packageWeight),
      }
    );
  }

  return {
    rate: centralRates[0],
    requestedMarketCode: marketCode,
    appliedMarketCode: centralRates[0].marketCode,
    rateSource: "CENTRAL_RATE",
  };
}
