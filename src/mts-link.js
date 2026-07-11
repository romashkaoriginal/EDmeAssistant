class MtsLinkService {
  constructor({ database, apiToken, webhookSecret, webhookSecretHeader = "x-webhook-secret", fetchImpl = fetch }) {
    this.database = database;
    this.apiToken = apiToken;
    this.webhookSecret = webhookSecret;
    this.webhookSecretHeader = webhookSecretHeader.toLowerCase();
    this.fetch = fetchImpl;
  }

  isConfigured() {
    return Boolean(this.apiToken && this.webhookSecret);
  }

  verifyWebhook(request) {
    return Boolean(this.webhookSecret) && request.get(this.webhookSecretHeader) === this.webhookSecret;
  }

  async fetchTranscript(transcriptId) {
    if (!this.apiToken) {
      const error = new Error("MTS_LINK_API_TOKEN is not configured");
      error.code = "MTS_LINK_NOT_CONFIGURED";
      throw error;
    }
    const response = await this.fetch(`https://userapi.mts-link.ru/v3/transcript/${encodeURIComponent(transcriptId)}`, {
      headers: { "x-auth-token": this.apiToken, "Content-Type": "application/x-www-form-urlencoded" },
    });
    if (!response.ok) throw new Error(`MTS Link transcript request failed with HTTP ${response.status}`);
    const body = await response.json();
    return body.data;
  }

  static toLocalTranscript(data) {
    const summary = data.summary?.status === "completed" ? data.summary.text?.trim() : "";
    const dialogue = (data.items || [])
      .map((item) => `${item.participant || "Участник"}: ${item.text || ""}`.trim())
      .filter(Boolean)
      .join("\n");
    const text = (summary || dialogue).slice(0, 20000);
    if (!text) throw new Error("MTS Link returned an empty transcript");
    return { lessonDate: (data.eventSessionEndsAt || new Date().toISOString()).slice(0, 10), text };
  }

  async processTranscriptReady(transcriptId) {
    const webhook = await this.database.getMtsWebhook(transcriptId);
    if (!webhook || webhook.status === "synced") return webhook;
    const session = await this.database.getMtsSession(webhook.eventSessionId);
    if (!session) return this.database.updateMtsWebhook(transcriptId, { status: "unmapped", errorMessage: "No student mapping for eventSessionId" });

    try {
      const externalTranscript = await this.fetchTranscript(transcriptId);
      const local = await this.database.createTranscript({
        studentId: session.studentId,
        tutorId: session.tutorId,
        ...MtsLinkService.toLocalTranscript(externalTranscript),
      });
      return this.database.updateMtsWebhook(transcriptId, { status: "synced", localTranscriptId: local.id, errorMessage: null });
    } catch (error) {
      return this.database.updateMtsWebhook(transcriptId, { status: "failed", errorMessage: error.message });
    }
  }
}

module.exports = { MtsLinkService };
