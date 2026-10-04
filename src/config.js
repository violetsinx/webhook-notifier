export function loadConfig(env = process.env) {
  const smtpPort = Number(env.SMTP_PORT || 465);
  return {
    port: Number(env.PORT || 3000),
    token: env.WEBHOOK_TOKEN || "",
    dryRun: /^(1|true|yes|on)$/i.test(env.DRY_RUN || ""),
    discordUrl: env.DISCORD_WEBHOOK_URL || "",
    email: {
      host: env.SMTP_HOST || "",
      port: smtpPort,
      secure: /^(1|true|yes|on)$/i.test(env.SMTP_SECURE || "") || smtpPort === 465,
      user: env.SMTP_USER || "",
      pass: env.SMTP_PASS || "",
      from: env.EMAIL_FROM || env.SMTP_USER || "",
      to: env.EMAIL_TO || "",
    },
  };
}
