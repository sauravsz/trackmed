import { NextResponse } from "next/server";
import { getAllCalculatedStates } from "@/lib/db";
import { Resend } from "resend";
import { format } from "date-fns";
import { sendTelegramDailyDigest } from "@/lib/telegram";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { settings, states } = await getAllCalculatedStates();

    const telegramBotToken = settings.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN;
    const telegramChatId = settings.telegram_chat_id || process.env.TELEGRAM_CHAT_ID;
    const telegramConfigured = Boolean(telegramBotToken && telegramChatId);
    const telegramEnabled = settings.telegram_enabled !== false && telegramConfigured;

    const emailTo = settings.reminder_email || process.env.REMINDER_EMAIL;
    const resendApiKey = process.env.RESEND_API_KEY;
    const emailConfigured = Boolean(emailTo && resendApiKey);
    const emailEnabled = Boolean(settings.reminders_enabled && emailConfigured);

    if (!telegramEnabled && !emailEnabled) {
      return NextResponse.json({
        success: true,
        message: "No active notification channels (Telegram or Email) are enabled/configured.",
        alerts_count: 0,
      });
    }

    // Filter medicines that require reorder attention and are NOT covered by in-transit orders
    const alertItems = states.filter(
      (s) =>
        (s.urgency === "CRITICAL" || s.urgency === "ORDER_NOW" || s.urgency === "ORDER_SOON") &&
        !s.in_transit.covers_stockout
    );

    const results: {
      telegram?: { attempted: boolean; success: boolean; error?: string; messageId?: number };
      email?: { attempted: boolean; success: boolean; error?: string; emailId?: string };
    } = {};

    // 1. Telegram Dispatch
    if (telegramEnabled && telegramBotToken && telegramChatId) {
      const telegramRes = await sendTelegramDailyDigest(telegramBotToken, telegramChatId, states);
      results.telegram = {
        attempted: true,
        success: telegramRes.success,
        error: telegramRes.error,
        messageId: telegramRes.messageId,
      };
    } else {
      results.telegram = {
        attempted: false,
        success: false,
        error: !telegramConfigured
          ? "Telegram bot token or chat ID not configured"
          : "Telegram notifications disabled in settings",
      };
    }
    // 2. Email Dispatch (Resend)
    if (emailEnabled && emailTo && resendApiKey) {
      const resend = new Resend(resendApiKey);
      const todayFormatted = format(new Date(), "dd MMMM yyyy");

      const emailHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #090c14; color: #f8fafc; border-radius: 12px; padding: 24px; border: 1px solid #1e293b;">
          <div style="border-bottom: 1px solid #1e293b; padding-bottom: 16px; margin-bottom: 20px;">
            <h1 style="margin: 0; font-size: 20px; font-weight: 700; color: #38bdf8;">TrackMed Daily Digest</h1>
            <p style="margin: 4px 0 0 0; font-size: 13px; color: #94a3b8;">${todayFormatted} • Multi-Channel Lead Time Report</p>
          </div>

          <p style="font-size: 14px; line-height: 1.5; color: #94a3b8;">
            ${
              alertItems.length === 0
                ? "All medicines have safe stock runways. No immediate reorders required today."
                : `The following <strong>${alertItems.length} medicine(s)</strong> have reached their ordering window based on channel lead times:`
            }
          </p>

          <div style="margin: 20px 0;">
            ${alertItems
              .map((item) => {
                const badgeColor =
                  item.urgency === "CRITICAL"
                    ? "#ef4444"
                    : item.urgency === "ORDER_NOW"
                    ? "#f97316"
                    : "#f59e0b";

                return `
                  <div style="background: #0f172a; border: 1px solid #1e293b; border-left: 4px solid ${badgeColor}; border-radius: 8px; padding: 14px; margin-bottom: 12px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                      <strong style="font-size: 15px; color: #f8fafc;">${item.medicine.name} ${
                  item.medicine.strength ? `(${item.medicine.strength})` : ""
                }</strong>
                      <span style="font-size: 11px; font-weight: bold; color: ${badgeColor}; text-transform: uppercase;">${
                  item.urgency_label
                }</span>
                    </div>
                    <div style="font-size: 13px; color: #94a3b8; margin-bottom: 6px;">
                      Stock on hand: <strong>${item.on_hand_stock} ${item.medicine.unit_label}</strong> (${item.days_remaining} days left)
                    </div>
                    <div style="font-size: 12px; background: #090c14; border: 1px solid #334155; padding: 8px 10px; border-radius: 6px; color: #e2e8f0;">
                      <strong>Action:</strong> ${item.recommended_action}
                    </div>
                  </div>
                `;
              })
              .join("")}
          </div>

          <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #1e293b; font-size: 12px; color: #64748b; text-align: center;">
            Sent by personal TrackMed health assistant.
          </div>
        </div>
      `;

      try {
        const { data, error } = await resend.emails.send({
          from: "TrackMed <onboarding@resend.dev>",
          to: emailTo,
          subject: `[TrackMed Alert] ${alertItems.length} Medicine(s) Require Reordering — ${todayFormatted}`,
          html: emailHtml,
        });

        results.email = {
          attempted: true,
          success: !error,
          error: error ? error.message : undefined,
          emailId: data?.id,
        };
      } catch (err: unknown) {
        results.email = {
          attempted: true,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    } else {
      results.email = {
        attempted: false,
        success: false,
        error: !emailTo ? "No email recipient configured" : "RESEND_API_KEY missing",
      };
    }

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      alerts_count: alertItems.length,
      dispatches: results,
      items: alertItems.map((a) => ({
        name: a.medicine.name,
        urgency: a.urgency,
        days_remaining: a.days_remaining,
        recommended_action: a.recommended_action,
      })),
    });
  } catch (error: unknown) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
