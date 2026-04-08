import { supabase } from "@/lib/supabase";
import type { MarketplaceBranding } from "@/lib/email-templates";

/**
 * Operátor (provozovatel Depozitky) — branding pro patičku všech emailů.
 * Bere se ze `dpt_settings.value` u řádku key='operator'.
 *
 * Toto NEPŘEPISUJE název bazaru (mp.name) ani kód (mp.code) — ty zůstávají
 * z `dpt_marketplaces`, aby v subjectech a textech zůstal název konkrétního
 * bazaru ("děkujeme za nákup na XYZ Bazar"). Přepisuje pouze logo, firmu,
 * adresu, IČO, support email, web a accent color.
 */
export interface OperatorBranding {
  companyName?: string;
  companyAddress?: string;
  companyId?: string;
  companyVatId?: string;
  logoUrl?: string;
  accentColor?: string;
  supportEmail?: string;
  websiteUrl?: string;
}

let cached: OperatorBranding | null = null;
let cachedAt = 0;
const TTL_MS = 30_000; // 30s in-memory cache

export async function getOperatorBranding(force = false): Promise<OperatorBranding> {
  const now = Date.now();
  if (!force && cached && now - cachedAt < TTL_MS) {
    return cached;
  }

  const { data, error } = await supabase
    .from("dpt_settings")
    .select("value")
    .eq("key", "operator")
    .maybeSingle();

  if (error || !data?.value) {
    cached = {};
    cachedAt = now;
    return cached;
  }

  const v = data.value as Record<string, string>;
  cached = {
    companyName: v.companyName || undefined,
    companyAddress: v.companyAddress || undefined,
    companyId: v.companyId || undefined,
    companyVatId: v.companyVatId || undefined,
    logoUrl: v.logoUrl || undefined,
    accentColor: v.accentColor || undefined,
    supportEmail: v.supportEmail || undefined,
    websiteUrl: v.websiteUrl || undefined,
  };
  cachedAt = now;
  return cached;
}

/**
 * Sloučí marketplace branding s operátorem. Operátorské hodnoty MAJÍ PŘEDNOST
 * pro logo, firmu, adresu, IČO, support, web, accent. Marketplace přispívá
 * pouze `name` a `code` (zůstává v subjectech/textech).
 */
export function applyOperatorBranding(
  mp: MarketplaceBranding,
  op: OperatorBranding,
): MarketplaceBranding {
  return {
    code: mp.code,
    name: mp.name,
    logoUrl: op.logoUrl ?? mp.logoUrl,
    accentColor: op.accentColor ?? mp.accentColor,
    companyName: op.companyName ?? mp.companyName,
    companyAddress: op.companyAddress ?? mp.companyAddress,
    companyId: op.companyId ?? mp.companyId,
    supportEmail: op.supportEmail ?? mp.supportEmail,
    websiteUrl: op.websiteUrl ?? mp.websiteUrl,
  };
}
