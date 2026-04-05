"use client";

import { useState, type FormEvent } from "react";

interface Carrier {
  value: string;
  label: string;
}

export default function ShipForm({
  token,
  carriers,
}: {
  token: string;
  carriers: Carrier[];
}) {
  const [carrier, setCarrier] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!carrier) return;

    setBusy(true);
    setResult(null);

    try {
      const res = await fetch("/api/ship", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, carrier, trackingNumber: trackingNumber.trim() }),
      });

      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));

      if (!res.ok || data.error) {
        setResult({ ok: false, message: data.error || `Chyba ${res.status}` });
      } else {
        setResult({ ok: true, message: "Zásilka byla zaregistrována. Děkujeme!" });
      }
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "Neznámá chyba" });
    } finally {
      setBusy(false);
    }
  }

  if (result?.ok) {
    return (
      <div className="alert alert-success">
        ✅ {result.message}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      {result && !result.ok && (
        <div className="alert alert-error" style={{ marginBottom: 14 }}>
          ❌ {result.message}
        </div>
      )}

      <label htmlFor="carrier">Dopravce *</label>
      <select
        id="carrier"
        value={carrier}
        onChange={(e) => setCarrier(e.target.value)}
        required
      >
        <option value="">Vyberte dopravce…</option>
        {carriers.map((c) => (
          <option key={c.value} value={c.value}>{c.label}</option>
        ))}
      </select>

      <label htmlFor="tracking">Tracking číslo</label>
      <input
        id="tracking"
        type="text"
        value={trackingNumber}
        onChange={(e) => setTrackingNumber(e.target.value)}
        placeholder="např. DR1234567890CZ"
      />

      <button type="submit" disabled={busy || !carrier}>
        {busy ? "Odesílám…" : "✓ Potvrdit odeslání"}
      </button>
    </form>
  );
}
