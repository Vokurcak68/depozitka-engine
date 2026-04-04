import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { resend, EMAIL_FROM } from "@/lib/resend";
import { verifyCron } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // Vercel Hobby: max 10s, Pro: 60s

/**
 * Process email queue: pick pending emails from dpt_email_queue, send via Resend.
 * 
 * Expected table: dpt_email_queue
 *   id, to_email, subject, html_body, text_body, status (pending/sent/failed),
 *   attempts, last_error, created_at, sent_at, transaction_id (optional FK)
 */
export async function GET(req: NextRequest) {
  const authError = verifyCron(req);
  if (authError) return authError;

  const BATCH_SIZE = 20; // Resend free: 100/day → conservative batch

  try {
    // Fetch pending emails (oldest first, max 3 attempts)
    const { data: emails, error: fetchError } = await supabase
      .from("dpt_email_queue")
      .select("*")
      .eq("status", "pending")
      .lt("attempts", 3)
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE);

    if (fetchError) {
      console.error("Failed to fetch email queue:", fetchError);
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }

    if (!emails || emails.length === 0) {
      return NextResponse.json({ processed: 0, message: "No pending emails" });
    }

    let sent = 0;
    let failed = 0;

    for (const email of emails) {
      try {
        const { error: sendError } = await resend.emails.send({
          from: EMAIL_FROM,
          to: email.to_email,
          subject: email.subject,
          html: email.html_body || undefined,
          text: email.text_body || undefined,
        });

        if (sendError) {
          throw new Error(sendError.message);
        }

        // Mark as sent
        await supabase
          .from("dpt_email_queue")
          .update({
            status: "sent",
            sent_at: new Date().toISOString(),
            attempts: email.attempts + 1,
          })
          .eq("id", email.id);

        sent++;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to send email ${email.id}:`, errorMsg);

        // Update attempts + error
        await supabase
          .from("dpt_email_queue")
          .update({
            status: email.attempts + 1 >= 3 ? "failed" : "pending",
            attempts: email.attempts + 1,
            last_error: errorMsg,
          })
          .eq("id", email.id);

        failed++;
      }
    }

    return NextResponse.json({ processed: emails.length, sent, failed });
  } catch (err) {
    console.error("process-emails error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
