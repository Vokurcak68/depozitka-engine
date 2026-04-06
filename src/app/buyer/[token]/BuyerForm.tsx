"use client";

import { useState, useEffect, useCallback } from "react";

interface TxInfo {
  transactionCode: string;
  status: string;
  buyerName: string;
  sellerName: string;
  amountCzk: number;
  addressFilled: boolean;
  addressLocked: boolean;
  address: {
    recipient_name: string;
    phone: string | null;
    street: string | null;
    city: string;
    postal_code: string | null;
    country: string;
  } | null;
}

interface PaymentInfo {
  accountNumber?: string;
  iban?: string;
  paymentReference?: string;
  amountCzk: number;
  paymentDueAt?: string;
  qrUrl?: string;
}

export default function BuyerForm({ token }: { token: string }) {
  const [tx, setTx] = useState<TxInfo | null>(null);
  const [payment, setPayment] = useState<PaymentInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  // Form state
  const [recipientName, setRecipientName] = useState("");
  const [phone, setPhone] = useState("");
  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [postalCode, setPostalCode] = useState("");

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/buyer-address?token=${token}`);
      if (!res.ok) throw new Error("Nepodařilo se načíst data");
      const data = await res.json();
      setTx(data);

      if (data.address) {
        setRecipientName(data.address.recipient_name || "");
        setPhone(data.address.phone || "");
        setStreet(data.address.street || "");
        setCity(data.address.city || "");
        setPostalCode(data.address.postal_code || "");
      } else {
        setRecipientName(data.buyerName || "");
      }

      // If address filled, load payment details
      if (data.addressFilled) {
        const payRes = await fetch(`/api/buyer-payment?token=${token}`);
        if (payRes.ok) {
          const payData = await payRes.json();
          setPayment(payData);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chyba");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");

    try {
      const res = await fetch("/api/buyer-address", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          recipient_name: recipientName,
          phone: phone || undefined,
          street: street || undefined,
          city,
          postal_code: postalCode || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Nepodařilo se uložit adresu");
      }

      setSuccess(true);
      // Reload to show payment details
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chyba");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="alert alert-info">⏳ Načítám...</div>;
  }

  if (!tx) {
    return <div className="alert alert-error">❌ Transakce nenalezena</div>;
  }

  const showForm = !tx.addressFilled || (!tx.addressLocked && !success);
  const showPayment = tx.addressFilled || success;

  return (
    <>
      {/* Transaction info */}
      <div className="info">
        <div><span>Transakce:</span> <strong>{tx.transactionCode}</strong></div>
        <div><span>Prodávající:</span> <strong>{tx.sellerName}</strong></div>
        <div><span>Částka:</span> <strong className="amount">{tx.amountCzk.toLocaleString("cs-CZ")} Kč</strong></div>
      </div>

      {/* Address form */}
      {showForm && !tx.addressLocked && (
        <>
          <h2 style={{ fontSize: "1.1rem", marginBottom: "12px" }}>
            📍 Kam zásilku doručit?
          </h2>
          <p style={{ fontSize: "0.85rem", color: "var(--muted)", marginBottom: "16px" }}>
            Vyplňte doručovací adresu. Po uložení se zobrazí platební údaje.
          </p>

          {error && <div className="alert alert-error">❌ {error}</div>}

          <form onSubmit={handleSubmit}>
            <label htmlFor="recipientName">Jméno příjemce *</label>
            <input
              type="text"
              id="recipientName"
              value={recipientName}
              onChange={(e) => setRecipientName(e.target.value)}
              required
              placeholder="Jan Novák"
            />

            <label htmlFor="phone">Telefon</label>
            <input
              type="text"
              id="phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+420 123 456 789"
            />

            <label htmlFor="street">Ulice a číslo</label>
            <input
              type="text"
              id="street"
              value={street}
              onChange={(e) => setStreet(e.target.value)}
              placeholder="Hlavní 123/4"
            />

            <label htmlFor="city">Město *</label>
            <input
              type="text"
              id="city"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              required
              placeholder="Praha"
            />

            <label htmlFor="postalCode">PSČ</label>
            <input
              type="text"
              id="postalCode"
              value={postalCode}
              onChange={(e) => setPostalCode(e.target.value)}
              placeholder="110 00"
            />

            <button type="submit" disabled={saving}>
              {saving ? "Ukládám..." : "💾 Uložit adresu a zobrazit platbu"}
            </button>
          </form>
        </>
      )}

      {/* Address locked info */}
      {tx.addressLocked && tx.address && (
        <div className="alert alert-info" style={{ marginBottom: "16px" }}>
          🔒 Doručovací adresa (nelze měnit po zaplacení):<br />
          <strong>{tx.address.recipient_name}</strong><br />
          {tx.address.street && <>{tx.address.street}<br /></>}
          {tx.address.city}{tx.address.postal_code && `, ${tx.address.postal_code}`}
          {tx.address.phone && <><br />📞 {tx.address.phone}</>}
        </div>
      )}

      {/* Payment details — shown after address is filled */}
      {showPayment && payment && (
        <div style={{ marginTop: "20px" }}>
          <h2 style={{ fontSize: "1.1rem", marginBottom: "12px" }}>
            💳 Platební údaje
          </h2>

          {success && (
            <div className="alert alert-success" style={{ marginBottom: "12px" }}>
              ✅ Adresa uložena! Na email vám posíláme platební údaje.
            </div>
          )}

          <div className="payment-box">
            {payment.accountNumber && (
              <div><span>Číslo účtu:</span> <strong>{payment.accountNumber}</strong></div>
            )}
            {payment.paymentReference && (
              <div><span>Variabilní symbol:</span> <strong className="vs">{payment.paymentReference}</strong></div>
            )}
            <div><span>Částka k úhradě:</span> <strong className="amount">{payment.amountCzk.toLocaleString("cs-CZ")} Kč</strong></div>
            {payment.paymentDueAt && (
              <div><span>Splatnost:</span> <strong>{new Date(payment.paymentDueAt).toLocaleDateString("cs-CZ", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}</strong></div>
            )}
          </div>

          {payment.qrUrl && (
            <div style={{ textAlign: "center", margin: "16px 0" }}>
              <p style={{ fontSize: "0.85rem", color: "var(--muted)", marginBottom: "8px" }}>
                Naskenujte QR kód pro rychlou platbu:
              </p>
              <img
                src={payment.qrUrl}
                alt="QR platba"
                width={200}
                height={200}
                style={{ borderRadius: "8px", border: "1px solid var(--border)", padding: "8px", background: "#fff" }}
              />
            </div>
          )}

          <div className="alert alert-info" style={{ marginTop: "16px" }}>
            🔒 <strong>Jak bezpečná platba funguje:</strong><br />
            1. Převedete částku na escrow účet<br />
            2. Peníze jsou bezpečně drženy, dokud nepotvrdíte převzetí<br />
            3. Po potvrzení doručení se výplata uvolní prodávajícímu
          </div>
        </div>
      )}

      {showPayment && !payment && !loading && (
        <div className="alert alert-info" style={{ marginTop: "16px" }}>
          ⏳ Platební údaje se načítají... Zkuste obnovit stránku.
        </div>
      )}
    </>
  );
}
