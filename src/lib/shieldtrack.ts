/**
 * ShieldTrack API client
 * Verifikace zásilek pro Depozitka escrow
 */

const SHIELDTRACK_BASE_URL =
  process.env.SHIELDTRACK_API_URL || "https://shieldtrack.lokopolis.cz";

const SHIELDTRACK_API_KEY = process.env.SHIELDTRACK_API_KEY || "";

// --- Types ---

export interface ShieldTrackRegisterData {
  tracking_number: string;
  carrier?: string;
  recipient_name?: string;
  recipient_city?: string;
  recipient_zip?: string;
  recipient_address?: string;
  external_order_id: string;
  sender_name?: string;
}

export interface ShieldTrackCheck {
  name: string;
  status: "passed" | "warning" | "failed" | "pending";
  detail: string | null;
}

export interface ShieldTrackVerification {
  shipment_id: string;
  status: "verified" | "partial" | "failed" | "pending";
  score: number;
  checks: ShieldTrackCheck[];
  address_match: {
    city: boolean;
    zip: boolean;
  } | null;
  verified_at: string | null;
  created_at: string;
}

export interface ShieldTrackShipment {
  id: string;
  tracking_number: string;
  external_order_id: string;
  verification: ShieldTrackVerification | null;
  created_at: string;
}

export interface ShieldTrackRegisterResponse {
  id: string;
  tracking_number: string;
  status: string;
  created_at: string;
}

// --- API functions ---

async function shieldtrackFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${SHIELDTRACK_BASE_URL}/api/v1${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": SHIELDTRACK_API_KEY,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `ShieldTrack API error: ${res.status} ${res.statusText} - ${text}`,
    );
  }

  return res.json() as Promise<T>;
}

/**
 * Registruje zásilku v ShieldTrack systému
 */
export async function registerShipment(
  data: ShieldTrackRegisterData,
): Promise<ShieldTrackRegisterResponse> {
  return shieldtrackFetch<ShieldTrackRegisterResponse>("/shipments", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

/**
 * Získá detail zásilky včetně verifikačních dat
 */
export async function getShipmentVerification(
  shipmentId: string,
): Promise<ShieldTrackShipment> {
  const raw = await shieldtrackFetch<{
    shipment: {
      id: string;
      tracking_number: string;
      external_order_id: string;
      created_at: string;
      verification_score: number | null;
      verification_details: {
        status?: string;
        summary?: string;
        lastChecked?: string;
      } | null;
    };
    events: unknown[];
    verification: {
      results: Array<{
        check_type: string;
        result: "pass" | "fail" | "warning" | "pending";
        details: string;
        checked_at: string;
      }>;
      report: {
        score: number;
        status: string;
        checks: Array<{
          type: string;
          result: string;
          points: number;
          maxPoints: number;
          details: string;
          label: string;
        }>;
        summary: string;
      };
    };
  }>(`/shipments/${shipmentId}`);

  const dbResults = raw.verification?.results;
  const shipment = raw.shipment;

  if (!dbResults || dbResults.length === 0) {
    return {
      id: shipment.id,
      tracking_number: shipment.tracking_number,
      external_order_id: shipment.external_order_id,
      verification: null,
      created_at: shipment.created_at,
    };
  }

  const statusMap: Record<
    string,
    "passed" | "failed" | "warning" | "pending"
  > = {
    pass: "passed",
    fail: "failed",
    warning: "warning",
    pending: "pending",
  };

  const checks: ShieldTrackCheck[] = dbResults.map((r) => ({
    name: r.check_type,
    status: statusMap[r.result] || "pending",
    detail: r.details,
  }));

  const cityCheck = dbResults.find((r) => r.check_type === "city_match");
  const zipCheck = dbResults.find((r) => r.check_type === "zip_match");
  const addressMatch =
    cityCheck || zipCheck
      ? {
          city: cityCheck?.result === "pass",
          zip: zipCheck?.result === "pass",
        }
      : null;

  const score = shipment.verification_score ?? 0;
  const dbStatus = shipment.verification_details?.status;
  const status = (
    ["verified", "partial", "failed", "pending"].includes(dbStatus || "")
      ? dbStatus
      : score >= 80
        ? "verified"
        : score >= 40
          ? "partial"
          : score > 0
            ? "failed"
            : "pending"
  ) as "verified" | "partial" | "failed" | "pending";

  const lastChecked = dbResults[0]?.checked_at || null;

  return {
    id: shipment.id,
    tracking_number: shipment.tracking_number,
    external_order_id: shipment.external_order_id,
    verification: {
      shipment_id: shipment.id,
      status,
      score,
      checks,
      address_match: addressMatch,
      verified_at: lastChecked,
      created_at: shipment.created_at,
    },
    created_at: shipment.created_at,
  };
}
