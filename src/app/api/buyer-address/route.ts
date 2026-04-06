import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendEmailDirect } from "@/lib/send-email-direct";

export const dynamic = "force-dynamic";

function cors(res: NextResponse): NextResponse {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return res;
}

export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

/**
 * GET /api/buyer-address?token=<uuid>
 * Returns transaction info for the buyer address form
 */
export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get("token");
    if (!token || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
      return cors(NextResponse.json({ error: "Neplatný token" }, { status: 400 }));
    }

    const { data: tx, error } = await supabase
      .from("dpt_transactions")
      .select("id, transaction_code, status, buyer_name, buyer_email, seller_name, amount_czk, buyer_address_filled")
      .eq("buyer_token", token)
      .single();

    if (error || !tx) {
      return cors(NextResponse.json({ error: "Transakce nenalezena" }, { status: 404 }));
    }

    // Check if address already exists
    let address = null;
    if (tx.buyer_address_filled) {
      const { data: addr } = await supabase
        .from("dpt_transaction_addresses")
        .select("recipient_name, phone, street, city, postal_code, country")
        .eq("transaction_id", tx.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      address = addr;
    }

    const isPaid = ["paid", "shipped", "delivered", "completed", "auto_completed", "payout_sent", "payout_confirmed"].includes(tx.status);

    return cors(NextResponse.json({
      transactionCode: tx.transaction_code,
      status: tx.status,
      buyerName: tx.buyer_name,
      sellerName: tx.seller_name,
      amountCzk: Number(tx.amount_czk),
      addressFilled: tx.buyer_address_filled,
      addressLocked: isPaid, // locked after payment
      address,
    }));
  } catch (err) {
    console.error("buyer-address GET error:", err);
    return cors(NextResponse.json({ error: "Interní chyba" }, { status: 500 }));
  }
}

/**
 * POST /api/buyer-address
 * Body: { token, recipient_name, phone?, street?, city, postal_code, country? }
 * Saves delivery address and sends payment details email
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { token, recipient_name, phone, street, city, postal_code, country } = body;

    if (!token || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
      return cors(NextResponse.json({ error: "Neplatný token" }, { status: 400 }));
    }

    if (!recipient_name?.trim() || !city?.trim()) {
      return cors(NextResponse.json({ error: "Jméno příjemce a město jsou povinné" }, { status: 400 }));
    }

    // Find transaction
    const { data: tx, error: txErr } = await supabase
      .from("dpt_transactions")
      .select("id, transaction_code, status, buyer_email, buyer_address_filled")
      .eq("buyer_token", token)
      .single();

    if (txErr || !tx) {
      return cors(NextResponse.json({ error: "Transakce nenalezena" }, { status: 404 }));
    }

    // Check if already locked (paid+)
    const isPaid = ["paid", "shipped", "delivered", "completed", "auto_completed", "payout_sent", "payout_confirmed"].includes(tx.status);
    if (isPaid) {
      return cors(NextResponse.json({ error: "Adresu nelze měnit po zaplacení" }, { status: 403 }));
    }

    // Upsert address — delete old + insert new
    await supabase
      .from("dpt_transaction_addresses")
      .delete()
      .eq("transaction_id", tx.id);

    const { error: insertErr } = await supabase
      .from("dpt_transaction_addresses")
      .insert({
        transaction_id: tx.id,
        recipient_name: recipient_name.trim(),
        phone: phone?.trim() || null,
        street: street?.trim() || null,
        city: city.trim(),
        postal_code: postal_code?.trim() || null,
        country: country?.trim() || "CZ",
      });

    if (insertErr) {
      console.error("Address insert failed:", insertErr);
      return cors(NextResponse.json({ error: "Nepodařilo se uložit adresu" }, { status: 500 }));
    }

    // Mark address as filled
    await supabase
      .from("dpt_transactions")
      .update({ buyer_address_filled: true })
      .eq("id", tx.id);

    // Send payment details email
    try {
      await sendEmailDirect(tx.id, "payment_details_buyer", tx.buyer_email);
    } catch (emailErr) {
      console.warn("Payment details email failed (non-blocking):", emailErr);
    }

    return cors(NextResponse.json({ ok: true }));
  } catch (err) {
    console.error("buyer-address POST error:", err);
    return cors(NextResponse.json({ error: "Interní chyba" }, { status: 500 }));
  }
}
