// Import Types
import type { BoothJobJobResponse } from "../types/gate.type";
import type { BoothJobDto, TicketProductDto, TicketJobDetailResponse } from "../types/worker.type";

import { MAX_RATING_SCORE, MIN_RATING_SCORE } from "../types/line.type";
import type { LineFlexComponent, LineMessage } from "../types/line.type";

// Import Utils
import { findTicketMarket } from "./ticket-payload";
import { formatBangkokDisplayDate } from "./time";

/* -------------------------------------- Config -------------------------------------- */

// Config สีหลักที่ใช้ซ้ำใน LINE Flex message
const TEXT_COLOR = "#2F3437";
const MUTED_COLOR = "#6B7280";
const BORDER_COLOR = "#E5E7EB";
const GREEN_COLOR = "#17C964";
const NEUTRAL_BUTTON_COLOR = "#D8DDE8";
const WARNING_COLOR = "#EF4444";
const STAR_COLOR = "#F6C343";

/* -------------------------------------- Functions -------------------------------------- */

// Function แปลงค่าว่างเป็นข้อความสำหรับแสดงผล
function asDisplayText(
  value: string | number | null | undefined
): string {
  const text =
    value === null || value === undefined
      ? ""
      : String(value).trim();

  return text || "-";
}

// Function format จำนวนสินค้าให้ตัดทศนิยมส่วนเกิน
function formatQuantity(
  value: string | number | null | undefined
): string {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return "-";
  }

  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) {
    return String(value);
  }

  return Number.isInteger(numberValue)
    ? String(numberValue)
    : numberValue
      .toFixed(2)
      .replace(/\.?0+$/, "");
}

// Function สร้างแถว label/value ใน Flex
function fieldRow(
  label: string,
  value: string | number | null | undefined
): LineFlexComponent {
  return {
    type: "box",
    layout: "horizontal",
    margin: "sm",
    contents: [
      {
        type: "text",
        text: label,
        size: "sm",
        color: MUTED_COLOR,
        flex: 5,
        wrap: true,
      },
      {
        type: "text",
        text: asDisplayText(value),
        size: "sm",
        color: TEXT_COLOR,
        weight: "bold",
        align: "end",
        flex: 7,
        wrap: true,
      },
    ],
  };
}

// Function สร้างเส้นคั่นใน Flex
function separator(
  margin = "lg"
): LineFlexComponent {
  return {
    type: "separator",
    margin,
    color: BORDER_COLOR,
  };
}

// Function สร้างแถวรายการสินค้า
function productSummaryRow(input: {
  name: string;
  quantity: string | number | null | undefined;
  packageName: string | null | undefined;
}): LineFlexComponent {
  return {
    type: "box",
    layout: "horizontal",
    margin: "sm",
    contents: [
      {
        type: "text",
        text: asDisplayText(input.name),
        size: "sm",
        color: TEXT_COLOR,
        flex: 7,
        wrap: true,
      },
      {
        type: "text",
        text: formatQuantity(input.quantity),
        size: "sm",
        color: TEXT_COLOR,
        align: "end",
        flex: 2,
      },
      {
        type: "text",
        text: asDisplayText(input.packageName),
        size: "sm",
        color: MUTED_COLOR,
        align: "end",
        flex: 3,
        wrap: true,
      },
    ],
  };
}

// Function สร้าง block สินค้าสำหรับ Vendor ตรวจยอด
function completionProductBlock(
  product: TicketProductDto,
  originalProduct?: TicketProductDto
): LineFlexComponent {
  // originalProduct คือแถวก่อนอัปเดต ใช้แสดง PackageCode ที่ Gate เคยประกาศไว้จริง เพราะถ้า Worker
  // เปลี่ยน PackageCode แล้ว product.packageName จะถูกเขียนทับเป็นค่าใหม่ไปแล้ว
  const declaredPackageName = asDisplayText(
    originalProduct?.packageName ?? product.packageName
  );
  const isPackageChanged =
    originalProduct !== undefined &&
    originalProduct.packageCode !== product.packageCode;

  return {
    type: "box",
    layout: "vertical",
    margin: "md",
    contents: [
      {
        type: "text",
        text: asDisplayText(product.productName),
        size: "sm",
        weight: "bold",
        color: TEXT_COLOR,
        wrap: true,
      },
      fieldRow(
        "ตามใบงาน",
        `${formatQuantity(
          originalProduct?.quantity ?? product.quantity
        )} ${declaredPackageName}`
      ),
      ...(isPackageChanged
        ? [
            fieldRow(
              "แพ็กเกจใหม่",
              asDisplayText(product.packageName)
            ),
          ]
        : []),
      fieldRow(
        "ส่งยอด",
        `${formatQuantity(
          product.confirmed_quantity
        )} ${asDisplayText(product.packageName)}`
      ),
    ],
  };
}

// Function สร้าง Bubble กลางสำหรับ Flex
function buildBubble(
  title: string,
  contents: LineFlexComponent[],
  footer?: LineFlexComponent
): Record<string, unknown> {
  return {
    type: "bubble",
    size: "mega",
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "20px",
      contents: [
        {
          type: "text",
          text: title,
          size: "xl",
          weight: "bold",
          color: TEXT_COLOR,
          wrap: true,
        },
        ...contents,
      ],
    },
    ...(footer ? { footer } : {}),
  };
}

// Function สร้างปุ่ม postback ใน Flex
function postbackButton(input: {
  label: string;
  data: string;
  displayText: string;
  style?: "primary" | "secondary" | "link";
  color?: string;
}): LineFlexComponent {
  return {
    type: "button",
    style: input.style ?? "primary",
    height: "sm",
    color: input.color,
    action: {
      type: "postback",
      label: input.label,
      data: input.data,
      displayText: input.displayText,
    },
  };
}

// Function สร้างข้อความแจ้งลงสินค้าของแต่ละแผง
export function buildBoothJobCreatedFlexMessage(
  response: BoothJobJobResponse,
  booth: BoothJobJobResponse["Booths"][number]
): LineMessage {
  const productRows: LineFlexComponent[] =
    booth.Products.flatMap(
      (product, index) => [
        ...(index > 0
          ? [separator("md")]
          : []),

        productSummaryRow({
          name: product.ProductName,
          quantity: product.Quantity,
          packageName: product.PackageName,
        }),
      ]
    );

  return {
    type: "flex",

    altText:
      `แจ้งลงสินค้า ${response.Ticket.TicketNo} ` +
      `${booth.BoothCode}`,

    contents: buildBubble(
      "แจ้งลงสินค้า",
      [
        fieldRow(
          "เลขที่งาน:",
          response.Ticket.TicketNo
        ),

        fieldRow(
          "ตลาด:",
          response.Market.MarketName
        ),

        fieldRow(
          "รหัสแผง:",
          booth.BoothCode
        ),

        fieldRow(
          "ชื่อแผง:",
          booth.BoothName
        ),

        fieldRow(
          "ทะเบียนรถ:",
          response.Ticket.LicensePlate
        ),


        separator(),

        {
          type: "text",
          text: "รายการสินค้า",
          size: "sm",
          weight: "bold",
          color: TEXT_COLOR,
          margin: "md",
          wrap: true,
        },

        ...productRows,

        separator(),

        {
          type: "text",
          text:
            "หากไม่ใช่สินค้าของท่าน กรุณาติดต่อร้านค้าต้นทางของท่าน",
          size: "xs",
          color: TEXT_COLOR,
          weight: "bold",
          margin: "md",
          wrap: true,
        },
      ]
    ),
  };
}

// Function สร้างข้อความแจ้งยกเลิกงานของแผง — ใช้ทั้งยกเลิกแผงเดียวตรงๆ และยกเลิกทางอ้อมจาก Market/Vehicle
export function buildBoothJobCancelledFlexMessage(input: {
  ticketNo: string;
  marketName: string;
  boothCode: string;
  boothName: string | null;
  licensePlate: string;
}): LineMessage {
  return {
    type: "flex",

    altText:
      `แจ้งยกเลิกงาน ${input.ticketNo} ` +
      `${input.boothCode}`,

    contents: buildBubble(
      "แจ้งยกเลิกงาน",
      [
        fieldRow(
          "เลขที่งาน:",
          input.ticketNo
        ),

        fieldRow(
          "ตลาด:",
          input.marketName
        ),

        fieldRow(
          "รหัสแผง:",
          input.boothCode
        ),

        fieldRow(
          "ชื่อแผง:",
          input.boothName
        ),

        fieldRow(
          "ทะเบียนรถ:",
          input.licensePlate
        ),

        separator(),

        {
          type: "text",
          text:
            "งานลงสินค้าของแผงนี้ถูกยกเลิกโดยเจ้าหน้าที่ หากมีข้อสงสัยกรุณาติดต่อเจ้าหน้าที่",
          size: "xs",
          color: TEXT_COLOR,
          weight: "bold",
          margin: "md",
          wrap: true,
        },
      ]
    ),
  };
}

// Function สร้างข้อความแจ้งว่างานของแผงถูกดึงทีมกลับไปรอจัดทีมใหม่ (Admin สั่งรถกลับไป "รอลง")
export function buildBoothJobWaitFlexMessage(input: {
  ticketNo: string;
  marketName: string;
  boothCode: string;
  boothName: string | null;
  licensePlate: string;
}): LineMessage {
  return {
    type: "flex",

    altText:
      `แจ้งรอจัดทีมใหม่ ${input.ticketNo} ` +
      `${input.boothCode}`,

    contents: buildBubble(
      "แจ้งรอจัดทีมงานใหม่",
      [
        fieldRow(
          "เลขที่งาน:",
          input.ticketNo
        ),

        fieldRow(
          "ตลาด:",
          input.marketName
        ),

        fieldRow(
          "รหัสแผง:",
          input.boothCode
        ),

        fieldRow(
          "ชื่อแผง:",
          input.boothName
        ),

        fieldRow(
          "ทะเบียนรถ:",
          input.licensePlate
        ),

        separator(),

        {
          type: "text",
          text:
            "ทีมงานสำหรับรถคันนี้ถูกดึงกลับเข้าคิว งานลงสินค้าของแผงนี้จะรอจัดทีมใหม่",
          size: "xs",
          color: TEXT_COLOR,
          weight: "bold",
          margin: "md",
          wrap: true,
        },
      ]
    ),
  };
}

// Function สร้างข้อความแจ้งว่างานของแผงถูกจัดทีมส่งงานอีกครั้ง (Admin สั่งรถกลับจาก "รอลง" เป็น "ลงเลย")
export function buildBoothJobDispatchResumedFlexMessage(input: {
  ticketNo: string;
  marketName: string;
  boothCode: string;
  boothName: string | null;
  licensePlate: string;
}): LineMessage {
  return {
    type: "flex",

    altText:
      `แจ้งเริ่มจัดทีมงาน ${input.ticketNo} ` +
      `${input.boothCode}`,

    contents: buildBubble(
      "แจ้งเริ่มจัดทีมงาน",
      [
        fieldRow(
          "เลขที่งาน:",
          input.ticketNo
        ),

        fieldRow(
          "ตลาด:",
          input.marketName
        ),

        fieldRow(
          "รหัสแผง:",
          input.boothCode
        ),

        fieldRow(
          "ชื่อแผง:",
          input.boothName
        ),

        fieldRow(
          "ทะเบียนรถ:",
          input.licensePlate
        ),

        separator(),

        {
          type: "text",
          text:
            "ทีมงานสำหรับรถคันนี้ถูกจัดส่งอีกครั้ง งานลงสินค้าของแผงนี้จะเริ่มดำเนินการตามปกติ",
          size: "xs",
          color: TEXT_COLOR,
          weight: "bold",
          margin: "md",
          wrap: true,
        },
      ]
    ),
  };
}

// Function สร้างข้อความให้ Vendor ตรวจสอบยอด
export function buildVendorCompletionReviewFlexMessage(input: {
  ticket: BoothJobDto;
  postbackData: {
    confirm: string;
    reject: string;
  };
  detail: TicketJobDetailResponse | null;
  products: TicketProductDto[];
  // Format originalProducts compares old and new PackageCode values
  originalProducts?: TicketProductDto[];
}): LineMessage {
  const market = findTicketMarket(
    input.detail,
    input.ticket
  );

  const originalProductById = new Map(
    (input.originalProducts ?? []).map((product) => [product.id, product])
  );

  const footer: LineFlexComponent = {
    type: "box",
    layout: "horizontal",
    spacing: "sm",
    contents: [
      postbackButton({
        label: "ถูกต้อง",
        data: input.postbackData.confirm,
        displayText: "ถูกต้อง",
        color: GREEN_COLOR,
      }),
      postbackButton({
        label: "ไม่ถูกต้อง",
        data: input.postbackData.reject,
        displayText: "ไม่ถูกต้อง",
        style: "secondary",
        color: NEUTRAL_BUTTON_COLOR,
      }),
    ],
  };

  return {
    type: "flex",

    altText:
      `กรุณาตรวจสอบข้อมูล ${market?.ticket_no ??
      input.detail?.vehicle_job.ticket_number ??
      input.ticket.boothCode
      }`,

    contents: buildBubble(
      "กรุณาตรวจสอบข้อมูล",
      [
        fieldRow(
          "เลขที่งานรถ:",
          input.detail?.vehicle_job.ticket_number
        ),

        fieldRow(
          "เลขที่ตั๋ว:",
          market?.ticket_no
        ),

        fieldRow(
          "รหัสแผง:",
          input.ticket.boothCode
        ),

        fieldRow(
          "ชื่อแผง:",
          input.ticket.boothName
        ),

        fieldRow(
          "ทะเบียนรถ:",
          input.detail?.vehicle_job.license_plate
        ),

        fieldRow(
          "ตลาด:",
          market?.marketName
        ),

        separator(),

        ...input.products.flatMap(
          (product, index) => [
            ...(index > 0
              ? [separator("md")]
              : []),

            completionProductBlock(
              product,
              originalProductById.get(product.id)
            ),
          ]
        ),
      ],
      footer
    ),
  };
}

// Function สร้างข้อความหลัง Vendor confirm หรือ reject
export function buildVendorCompletionResultFlexMessage(input: {
  ticket: BoothJobDto;
  detail: TicketJobDetailResponse | null;
  isConfirmed: boolean;
}): LineMessage {
  const market = findTicketMarket(input.detail, input.ticket);
  const text =
    input.isConfirmed
      ? "คุณได้ยืนยันข้อมูลถูกต้อง ปิดงานเรียบร้อย"
      : "คุณได้แจ้งข้อมูลไม่ถูกต้องแล้ว กรุณารอคนงานส่งยอดใหม่อีกครั้ง";

  const title =
    input.isConfirmed
      ? "ยืนยันข้อมูลสำเร็จ"
      : "แจ้งตีกลับข้อมูลแล้ว";

  return {
    type: "flex",

    altText: text,

    contents: buildBubble(
      title,
      [
        fieldRow(
          "เลขที่งานรถ:",
          input.detail?.vehicle_job.ticket_number
        ),

        fieldRow(
          "เลขที่ตั๋ว:",
          market?.ticket_no
        ),

        fieldRow(
          "รหัสแผง:",
          input.ticket.boothCode
        ),

        fieldRow(
          "ชื่อแผง:",
          input.ticket.boothName
        ),

        separator(),

        {
          type: "text",
          text,
          size: "md",
          color:
            input.isConfirmed
              ? TEXT_COLOR
              : WARNING_COLOR,
          weight: "bold",
          wrap: true,
          align: "center",
          margin: "md",
        },
      ]
    ),
  };
}

// Function สร้างข้อความขอคะแนนหลังปิดงาน
export function buildVendorRatingPromptFlexMessage(input: {
  ticket: BoothJobDto;
  detail: TicketJobDetailResponse | null;
  ratingToken: string;
}): LineMessage {
  const market = findTicketMarket(input.detail, input.ticket);

  return {
    type: "flex",

    altText:
      `กรุณาให้คะแนน ${market?.ticket_no ??
      input.detail?.vehicle_job.ticket_number ??
      input.ticket.boothCode
      }`,

    contents: buildBubble(
      "กรุณาให้คะแนน",
      [
        separator(),

        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          margin: "lg",

          contents: Array.from(
            { length: MAX_RATING_SCORE - MIN_RATING_SCORE + 1 },
            (_, index) => MIN_RATING_SCORE + index
          ).map(
            (score) =>
              postbackButton({
                label: String(score),

                data:
                  `token=${input.ratingToken}` +
                  `&score=${score}`,

                displayText:
                  String(score),

                style: "link",

                color:
                  MUTED_COLOR,
              })
          ),
        },
      ]
    ),
  };
}

// Function สร้างข้อความสรุปหลัง Vendor ให้คะแนน
export function buildVendorRatingResultFlexMessages(input: {
  ticket: BoothJobDto;
  detail: TicketJobDetailResponse | null;
  score: number;
  stallAmountBaht: number;
}): LineMessage[] {
  const market = findTicketMarket(input.detail, input.ticket);
  const ticketNumber =
    input.detail?.vehicle_job.ticket_number ??
    "-";
  const ticketNo =
    market?.ticket_no ??
    ticketNumber;

  const stars =
    `${"★".repeat(input.score)}` +
    `${"☆".repeat(MAX_RATING_SCORE - input.score)}`;

  return [
    {
      type: "flex",

      altText:
        `ขอบคุณสำหรับการให้คะแนน ` +
        `${input.score}/5`,

      contents: buildBubble(
        "ขอบคุณ! สำหรับการให้คะแนน",
        [
          separator(),

          {
            type: "text",
            text: stars,
            size: "xl",
            color: STAR_COLOR,
            align: "center",
            margin: "lg",
            wrap: true,
          },
        ]
      ),
    },

    {
      type: "flex",

      altText:
        `สรุปค่าใช้บริการ ${ticketNo}`,

      contents: buildBubble(
        "สรุปค่าใช้บริการ",
        [
          separator(),

          {
            type: "text",
            text:
              `เลขที่งาน ${ticketNo}`,
            size: "md",
            color: TEXT_COLOR,
            align: "center",
            margin: "lg",
            wrap: true,
          },

          {
            type: "text",
            text:
              formatBangkokDisplayDate(
                market?.ticket_created_at
              ),
            size: "md",
            color: TEXT_COLOR,
            align: "center",
            wrap: true,
          },

          {
            type: "text",
            text:
              `ลงแผง ${input.ticket.boothCode} ` +
              `${asDisplayText(
                input.ticket.boothName
              )}`,
            size: "md",
            color: TEXT_COLOR,
            align: "center",
            wrap: true,
          },

          {
            type: "text",
            text:
              `${input.stallAmountBaht.toFixed(
                2
              )} บาท`,
            size: "xl",
            weight: "bold",
            color: TEXT_COLOR,
            align: "center",
            margin: "lg",
            wrap: true,
          },

          {
            type: "text",
            text: "ขอบคุณที่ใช้บริการ",
            size: "sm",
            color: TEXT_COLOR,
            align: "center",
            margin: "md",
            wrap: true,
          },
        ]
      ),
    },
  ];
}
