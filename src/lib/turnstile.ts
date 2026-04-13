type TurnstileResult = {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  // Cloudflare uses "error-codes" (hyphen). We normalize to camel/snake.
  error_codes?: string[];
  action?: string;
  cdata?: string;
};

export async function verifyTurnstile(params: {
  token: string;
  remoteIp?: string;
  action?: string;
}): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) throw new Error("Missing TURNSTILE_SECRET_KEY");

  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", params.token);
  if (params.remoteIp) body.set("remoteip", params.remoteIp);

  const res = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }
  );

  if (!res.ok) {
    throw new Error(`Turnstile verify failed: HTTP ${res.status}`);
  }

  const raw = (await res.json()) as any;

  const json: TurnstileResult = {
    ...raw,
    error_codes: raw?.error_codes || raw?.["error-codes"],
  };

  // Optional action check (Turnstile supports it)
  if (json.success && params.action && json.action && json.action !== params.action) {
    return { ...json, success: false, error_codes: ["action-mismatch"] };
  }

  return json;
}
