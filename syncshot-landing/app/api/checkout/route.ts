/** Fail closed until Razorpay domain approval and verified order/webhook handling
 * are deployed. The public demo never sends a payment request or grants access. */
export async function POST() {
  return Response.json({ error: "Payments are not live. Demo checkout does not create orders or grant access.", mode: "demo" }, { status: 503, headers: { "Cache-Control": "no-store" } })
}
