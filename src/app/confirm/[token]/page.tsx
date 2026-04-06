import { getSupabase } from "@/lib/supabase";
import { notFound } from "next/navigation";
import ConfirmForm from "./ConfirmForm";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function ConfirmPage({ params }: Props) {
  const { token } = await params;
  const supabase = getSupabase();

  const { data: tx } = await supabase
    .from("dpt_transactions")
    .select("id, transaction_code, status, amount_czk, buyer_name, seller_name, shipping_carrier, shipping_tracking_number, shipped_at, dispute_reason")
    .eq("delivery_confirm_token", token)
    .single();

  if (!tx) return notFound();

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 16px",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "520px",
          background: "#1e293b",
          borderRadius: "16px",
          border: "1px solid #334155",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "24px",
            borderBottom: "1px solid #334155",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: "32px", marginBottom: "8px" }}>📦</div>
          <h1 style={{ fontSize: "20px", fontWeight: 700, color: "#f1f5f9", margin: 0 }}>
            Potvrzení doručení
          </h1>
          <p style={{ fontSize: "14px", color: "#94a3b8", marginTop: "6px" }}>
            Transakce <strong style={{ color: "#60a5fa" }}>{tx.transaction_code}</strong>
          </p>
        </div>

        {/* Info */}
        <div style={{ padding: "20px 24px", borderBottom: "1px solid #334155" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <InfoItem label="Prodávající" value={tx.seller_name} />
            <InfoItem label="Částka" value={`${Number(tx.amount_czk).toLocaleString("cs-CZ")} Kč`} />
            <InfoItem label="Přepravce" value={tx.shipping_carrier || "—"} />
            <InfoItem label="Tracking" value={tx.shipping_tracking_number || "—"} mono />
            {tx.shipped_at && (
              <InfoItem
                label="Odesláno"
                value={new Date(tx.shipped_at).toLocaleDateString("cs-CZ")}
              />
            )}
          </div>
        </div>

        {/* Form area */}
        <ConfirmForm
          token={token}
          status={tx.status}
          transactionCode={tx.transaction_code}
          disputeReason={tx.dispute_reason}
        />
      </div>
    </main>
  );
}

function InfoItem({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "2px" }}>
        {label}
      </div>
      <div
        style={{
          fontSize: "14px",
          color: "#e2e8f0",
          fontFamily: mono ? "monospace" : "inherit",
          wordBreak: "break-all",
        }}
      >
        {value}
      </div>
    </div>
  );
}
