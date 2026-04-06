"use client";

import { useState, type FormEvent } from "react";

// Czech bank codes
const BANKS = [
  { code: "0100", name: "Komerční banka" },
  { code: "0300", name: "ČSOB" },
  { code: "0600", name: "MONETA Money Bank" },
  { code: "0710", name: "Česká národní banka" },
  { code: "0800", name: "Česká spořitelna" },
  { code: "2010", name: "Fio banka" },
  { code: "2020", name: "CREDITAS" },
  { code: "2060", name: "Citfin" },
  { code: "2070", name: "Moravský Peněžní Ústav" },
  { code: "2100", name: "Hypoteční banka" },
  { code: "2200", name: "Citfin" },
  { code: "2220", name: "Artesa" },
  { code: "2240", name: "Poštovní spořitelna" },
  { code: "2250", name: "Banka CREDITAS" },
  { code: "2260", name: "NEY spořitelní družstvo" },
  { code: "2275", name: "Podnikatelská družstevní záložna" },
  { code: "2600", name: "Citibank" },
  { code: "2700", name: "UniCredit Bank" },
  { code: "3030", name: "Air Bank" },
  { code: "3050", name: "BNP Paribas" },
  { code: "3060", name: "PKO BP" },
  { code: "3500", name: "ING Bank" },
  { code: "4000", name: "Max banka (ex. Expobank)" },
  { code: "4300", name: "Národní rozvojová banka" },
  { code: "5500", name: "Raiffeisenbank" },
  { code: "5800", name: "J&T Banka" },
  { code: "6000", name: "PPF banka" },
  { code: "6100", name: "Equa bank" },
  { code: "6200", name: "COMMERZBANK" },
  { code: "6210", name: "mBank" },
  { code: "6300", name: "BNP Paribas" },
  { code: "6700", name: "Všeobecná úverová banka" },
  { code: "6800", name: "Sberbank CZ (v likvidaci)" },
  { code: "7910", name: "Deutsche Bank" },
  { code: "7940", name: "Waldviertler Sparkasse Bank" },
  { code: "7950", name: "Raiffeisen stavební spořitelna" },
  { code: "7960", name: "ČSOB stavební spořitelna" },
  { code: "7970", name: "Modrá pyramida" },
  { code: "7990", name: "Oberbank" },
  { code: "8030", name: "Volksbank Raiffeisenbank" },
  { code: "8040", name: "Oberbank" },
  { code: "8060", name: "Stavební spořitelna ČS" },
  { code: "8090", name: "Česká exportní banka" },
  { code: "8150", name: "HSBC" },
  { code: "8200", name: "PRIVAT BANK" },
  { code: "8215", name: "TRINITY BANK" },
  { code: "8220", name: "Payment Execution" },
  { code: "8230", name: "MUFG Bank" },
  { code: "8240", name: "Družstevní záložna Kredit" },
  { code: "8250", name: "Bank of China" },
  { code: "8260", name: "PAYMASTER" },
  { code: "8270", name: "Fairplay Pay" },
  { code: "8280", name: "B-Efekt" },
  { code: "8292", name: "NLB" },
  { code: "8293", name: "Partner banka" },
];

function formatIbanDisplay(iban: string): string {
  return iban.replace(/(.{4})/g, "$1 ").trim();
}

export default function PayoutAccountForm({
  token,
  currentIban,
  currentName,
  locked,
}: {
  token: string;
  currentIban: string | null;
  currentName: string | null;
  locked: boolean;
}) {
  const [accountNumber, setAccountNumber] = useState("");
  const [bankCode, setBankCode] = useState("");
  const [accountName, setAccountName] = useState("");
  const [busy, setBusy] = useState(false);
  const [savedIban, setSavedIban] = useState(currentIban);
  const [savedName, setSavedName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(!currentIban);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!accountNumber.trim() || !bankCode) return;

    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/seller-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          account_number: accountNumber.trim(),
          bank_code: bankCode,
          account_name: accountName.trim(),
        }),
      });

      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));

      if (!res.ok || data.error) {
        setError(data.error || `Chyba ${res.status}`);
      } else {
        setSavedIban(data.iban);
        setSavedName(accountName.trim() || null);
        setEditing(false);
        setAccountNumber("");
        setBankCode("");
        setAccountName("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Neznámá chyba");
    } finally {
      setBusy(false);
    }
  }

  // Already saved and not editing
  if (savedIban && !editing) {
    return (
      <div style={{ marginBottom: "20px" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "8px" }}>🏦 Účet pro výplatu</h2>
        <div className="alert alert-success">
          <strong>IBAN:</strong> {formatIbanDisplay(savedIban)}<br />
          {savedName && <><strong>Jméno:</strong> {savedName}<br /></>}
          ✅ Účet je uložen
        </div>
        {!locked && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            style={{
              background: "none", border: "1px solid var(--border)", borderRadius: "8px",
              padding: "8px 16px", fontSize: "0.85rem", color: "var(--muted)", cursor: "pointer",
              marginTop: "4px",
            }}
          >
            ✏️ Změnit účet
          </button>
        )}
      </div>
    );
  }

  // Locked — cannot edit
  if (locked) {
    return (
      <div style={{ marginBottom: "20px" }}>
        <h2 style={{ fontSize: "1rem", marginBottom: "8px" }}>🏦 Účet pro výplatu</h2>
        <div className="alert alert-info">
          🔒 Údaje o výplatě jsou zamčené.
          {savedIban && <><br /><strong>IBAN:</strong> {formatIbanDisplay(savedIban)}</>}
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: "20px" }}>
      <h2 style={{ fontSize: "1rem", marginBottom: "8px" }}>🏦 Účet pro výplatu</h2>
      <p style={{ fontSize: "0.85rem", color: "var(--muted)", marginBottom: "12px" }}>
        Zadejte číslo účtu, na který chcete obdržet výplatu po dokončení transakce.
      </p>

      <form onSubmit={handleSubmit}>
        {error && (
          <div className="alert alert-error" style={{ marginBottom: 14 }}>
            ❌ {error}
          </div>
        )}

        <label htmlFor="accountNumber">Číslo účtu *</label>
        <input
          id="accountNumber"
          type="text"
          value={accountNumber}
          onChange={(e) => setAccountNumber(e.target.value)}
          placeholder="např. 123456789 nebo 19-123456789"
          required
        />

        <label htmlFor="bankCode">Banka *</label>
        <select
          id="bankCode"
          value={bankCode}
          onChange={(e) => setBankCode(e.target.value)}
          required
        >
          <option value="">Vyberte banku…</option>
          {BANKS.map((b) => (
            <option key={b.code} value={b.code}>
              {b.code} — {b.name}
            </option>
          ))}
        </select>

        <label htmlFor="accountName">Jméno majitele účtu</label>
        <input
          id="accountName"
          type="text"
          value={accountName}
          onChange={(e) => setAccountName(e.target.value)}
          placeholder="Nepovinné — jméno na účtu"
        />

        <button type="submit" disabled={busy || !accountNumber.trim() || !bankCode}>
          {busy ? "Ukládám…" : "💾 Uložit účet"}
        </button>
      </form>

      {savedIban && (
        <button
          type="button"
          onClick={() => { setEditing(false); setError(null); }}
          style={{
            background: "none", border: "none", padding: "8px",
            fontSize: "0.85rem", color: "var(--accent)", cursor: "pointer", marginTop: "8px",
          }}
        >
          ← Zpět
        </button>
      )}
    </div>
  );
}
