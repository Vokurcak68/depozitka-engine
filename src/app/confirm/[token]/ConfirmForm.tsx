"use client";

import { useState, useRef } from "react";

interface ConfirmFormProps {
  token: string;
  status: string;
  transactionCode: string;
  disputeReason: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  shipped: "Odesláno",
  delivered: "Doručeno",
  completed: "Dokončeno — potvrzeno kupujícím",
  auto_completed: "Dokončeno automaticky",
  disputed: "Spor",
  cancelled: "Zrušeno",
  refunded: "Vráceno",
  payout_sent: "Výplata odeslána",
  payout_confirmed: "Výplata potvrzena",
};

export default function ConfirmForm({ token, status, transactionCode, disputeReason }: ConfirmFormProps) {
  const [view, setView] = useState<"main" | "dispute">("main");
  const [reason, setReason] = useState("");
  const [evidenceUrls, setEvidenceUrls] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const canAct = ["shipped", "delivered"].includes(status);

  // --- Already actioned ---
  if (!canAct) {
    return (
      <div style={{ padding: "24px", textAlign: "center" }}>
        <div style={{ fontSize: "48px", marginBottom: "12px" }}>
          {status === "completed" || status === "auto_completed" ? "✅" : status === "disputed" ? "⚠️" : "ℹ️"}
        </div>
        <h2 style={{ fontSize: "18px", color: "#f1f5f9", fontWeight: 600, marginBottom: "8px" }}>
          {status === "completed" ? "Doručení bylo potvrzeno" :
           status === "auto_completed" ? "Transakce byla dokončena automaticky" :
           status === "disputed" ? "Spor otevřen" :
           STATUS_LABELS[status] || status}
        </h2>
        {status === "disputed" && disputeReason && (
          <p style={{ fontSize: "13px", color: "#94a3b8", marginTop: "8px" }}>
            Důvod: {disputeReason}
          </p>
        )}
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "8px" }}>
          Nemůžete provést další akci na této transakci.
        </p>
      </div>
    );
  }

  // --- Confirm delivery ---
  async function handleConfirm() {
    if (!confirm("Opravdu potvrzujete, že jste zboží obdrželi v pořádku?")) return;
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch("/api/buyer-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action: "confirm" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Chyba");
      setResult({ type: "success", message: "✅ Doručení potvrzeno! Prodávající obdrží výplatu." });
    } catch (e) {
      setResult({ type: "error", message: e instanceof Error ? e.message : "Chyba" });
    } finally {
      setSubmitting(false);
    }
  }

  // --- File upload for dispute evidence ---
  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);

    for (const file of Array.from(files)) {
      // Convert to base64 data URL for now (Supabase storage upload needs auth)
      // In production, use presigned upload URL
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          setEvidenceUrls((prev) => [...prev, reader.result as string]);
        }
      };
      reader.readAsDataURL(file);
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  // --- Submit dispute ---
  async function handleDispute() {
    if (!reason.trim()) {
      setResult({ type: "error", message: "Vyplňte důvod sporu." });
      return;
    }
    if (!confirm("Opravdu chcete otevřít spor? Výplata prodávajícímu bude pozastavena do vyřešení.")) return;

    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch("/api/buyer-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          action: "dispute",
          reason: reason.trim(),
          evidence_urls: evidenceUrls.filter((u) => u.startsWith("data:")),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Chyba");
      setResult({ type: "success", message: "⚠️ Spor otevřen. Administrátor ho bude řešit." });
    } catch (e) {
      setResult({ type: "error", message: e instanceof Error ? e.message : "Chyba" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ padding: "24px" }}>
      {/* Result banner */}
      {result && (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: "10px",
            marginBottom: "16px",
            background: result.type === "success" ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
            border: `1px solid ${result.type === "success" ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
            color: result.type === "success" ? "#22c55e" : "#ef4444",
            fontSize: "14px",
          }}
        >
          {result.message}
        </div>
      )}

      {result?.type === "success" ? null : view === "main" ? (
        <>
          <p style={{ fontSize: "14px", color: "#94a3b8", marginBottom: "20px", lineHeight: 1.6 }}>
            Obdrželi jste zásilku z transakce <strong style={{ color: "#e2e8f0" }}>{transactionCode}</strong>?
            Potvrďte doručení, nebo otevřete spor pokud je něco špatně.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <button
              onClick={handleConfirm}
              disabled={submitting}
              style={{
                padding: "14px 20px",
                borderRadius: "10px",
                fontSize: "15px",
                fontWeight: 600,
                cursor: submitting ? "not-allowed" : "pointer",
                opacity: submitting ? 0.6 : 1,
                border: "1px solid rgba(34,197,94,0.3)",
                background: "rgba(34,197,94,0.15)",
                color: "#22c55e",
                transition: "all 0.2s",
              }}
            >
              ✅ Potvrdit doručení — vše v pořádku
            </button>

            <button
              onClick={() => setView("dispute")}
              disabled={submitting}
              style={{
                padding: "14px 20px",
                borderRadius: "10px",
                fontSize: "15px",
                fontWeight: 600,
                cursor: "pointer",
                border: "1px solid rgba(239,68,68,0.3)",
                background: "rgba(239,68,68,0.08)",
                color: "#ef4444",
                transition: "all 0.2s",
              }}
            >
              ⚠️ Otevřít spor — problém se zásilkou
            </button>
          </div>
        </>
      ) : (
        <>
          <h3 style={{ fontSize: "16px", fontWeight: 600, color: "#ef4444", marginBottom: "16px" }}>
            ⚠️ Otevření sporu
          </h3>

          <div style={{ marginBottom: "16px" }}>
            <label style={{ display: "block", fontSize: "13px", color: "#94a3b8", marginBottom: "6px" }}>
              Důvod sporu <span style={{ color: "#ef4444" }}>*</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              placeholder="Popište problém — co jste očekávali a co jste obdrželi..."
              style={{
                width: "100%",
                padding: "12px",
                borderRadius: "10px",
                border: "1px solid #334155",
                background: "#0f172a",
                color: "#e2e8f0",
                fontSize: "14px",
                resize: "vertical",
                boxSizing: "border-box",
                fontFamily: "inherit",
              }}
            />
          </div>

          <div style={{ marginBottom: "16px" }}>
            <label style={{ display: "block", fontSize: "13px", color: "#94a3b8", marginBottom: "6px" }}>
              Fotky jako důkaz (volitelné)
            </label>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleFileUpload}
              disabled={uploading}
              style={{ display: "none" }}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              style={{
                padding: "10px 16px",
                borderRadius: "8px",
                border: "2px dashed #334155",
                background: "transparent",
                color: "#94a3b8",
                cursor: "pointer",
                fontSize: "13px",
              }}
            >
              📷 {uploading ? "Nahrávám..." : "Přidat fotky"}
            </button>

            {evidenceUrls.length > 0 && (
              <div style={{ display: "flex", gap: "8px", marginTop: "10px", flexWrap: "wrap" }}>
                {evidenceUrls.map((url, i) => (
                  <div
                    key={i}
                    style={{
                      width: "60px",
                      height: "60px",
                      borderRadius: "8px",
                      overflow: "hidden",
                      border: "1px solid #334155",
                      position: "relative",
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url} alt={`Důkaz ${i + 1}`} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    <button
                      onClick={() => setEvidenceUrls((prev) => prev.filter((_, j) => j !== i))}
                      style={{
                        position: "absolute",
                        top: "-4px",
                        right: "-4px",
                        width: "18px",
                        height: "18px",
                        borderRadius: "50%",
                        background: "#ef4444",
                        color: "#fff",
                        border: "none",
                        cursor: "pointer",
                        fontSize: "10px",
                        fontWeight: 700,
                        lineHeight: "18px",
                        textAlign: "center",
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: "10px" }}>
            <button
              onClick={handleDispute}
              disabled={submitting}
              style={{
                flex: 1,
                padding: "14px",
                borderRadius: "10px",
                fontSize: "14px",
                fontWeight: 600,
                cursor: submitting ? "not-allowed" : "pointer",
                opacity: submitting ? 0.6 : 1,
                border: "1px solid rgba(239,68,68,0.3)",
                background: "rgba(239,68,68,0.1)",
                color: "#ef4444",
              }}
            >
              ⚠️ Odeslat spor
            </button>
            <button
              onClick={() => { setView("main"); setReason(""); setEvidenceUrls([]); }}
              style={{
                flex: 1,
                padding: "14px",
                borderRadius: "10px",
                fontSize: "14px",
                fontWeight: 600,
                cursor: "pointer",
                border: "1px solid #334155",
                background: "transparent",
                color: "#94a3b8",
              }}
            >
              ← Zpět
            </button>
          </div>
        </>
      )}
    </div>
  );
}
