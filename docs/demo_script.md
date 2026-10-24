# Demo script (about 4 minutes)

The demo runs on the live site, [healthcopilot.duckdns.org](https://healthcopilot.duckdns.org), with the demo family.
A shorter script for upload, review and FHIR is at the end.

## Before the demo (10 minutes earlier)

- [ ] **Reset the demo family** (no LLM calls): on the server, `docker exec health-copilot python -m app.demo`.
      Locally: `cd backend && .venv/bin/python -m app.demo`. It creates three profiles on `demo@healthcopilot.in`
      (password `demo12345`):
      - *Ravi Kumar* (36, English): a fever prescription from 3 days ago;
      - *Ramesh Kumar* (father, 64, Hindi): HbA1c 7.4% → 7.9% → 8.6% over three reports, on diabetes and BP tablets;
      - *Lakshmi Kumar* (mother, 59, Telugu): low haemoglobin and ferritin, high TSH, on thyroid and iron tablets.
- [ ] **Model quota.** Chat, summaries and translations use Gemini (about 20 requests per model per day on the free
      tier). Use a key with billing, or check `/api/health` and pre-warm: open the Insights page once in Hindi and
      Telugu so the translations are cached.
- [ ] **Notifications.** On the demo laptop or phone, open Reminders and click *Get reminders on this device*; a test
      notification arrives. Allow notifications when the browser asks.
- [ ] **Browser.** Sign in, zoom 110%, sidebar visible, language English, profile *Ravi Kumar*.
- [ ] **For the live upload:** `eval/samples/rx_bilingual_telugu.png` to hand.

## Script

| Time | Screen | Say / do |
|---|---|---|
| 0:00–0:20 | Dashboard (Ravi) | "Health Copilot turns paper records into a verified health record, then keeps the family on track: reminders, insights, wellness and an agent that acts for you and shows its work." Point at *Today's medicines* and *Copilot found*. |
| 0:20–0:55 | Copilot actions (Ravi) | **Scenario 1, new prescription.** "Ravi saw a doctor for fever 3 days ago. When he confirmed the prescription, the copilot scheduled the reminders: Azee for 5 days, Pan 40 *before food* at 07:30, and it skipped Dolo because it's SOS. It also drafted three questions for the next visit." Click *Edit* on a question, then *Visit sheet* to show the printable page. "Every action has Keep, Edit and Undo: the user is in control." |
| 0:55–1:30 | Reminders (whole family) | "One screen for the whole family's day, at each prescription's own times." Mark a dose *Taken*, *Snooze* another. Click the *Ended* tab: "The antibiotic ends with its 5-day course; the reminder stops by itself." Show *Visits and tests*: the follow-ups were read from the doctor's notes. |
| 1:30–2:20 | Insights (switch to Ramesh) | **Scenario 2, father with rising sugar.** "Ramesh's HbA1c was above range in 3 reports and still rising: 7.4, 7.9, 8.6. The copilot flags the trend, cites each result and date, and links to the source record." Scroll to *Preventive next steps*: "His follow-up and repeat HbA1c are overdue, so it prompts them." Point at the combinations (sugar with LDL, kidney with diabetes) and the wellness plan with a *why* for every tip. "All of this is computed in code from his own results, worded for a talk with the doctor, never a diagnosis." |
| 2:20–2:40 | Copilot actions (Ramesh) | "The daily check flagged the overdue follow-up and HbA1c, and noticed his kidney test is due again." Click *Add to reminders* on the kidney test: it appears under Visits and tests. |
| 2:40–3:20 | Ask Copilot (switch to Lakshmi, Telugu) | **Scenario 3, elderly user by voice.** Switch language to తెలుగు, turn on *Speak replies* under the microphone, then tap the microphone and say *ఈ రాత్రి నేను ఏ మందులు వేసుకోవాలి?* ("Which medicines do I take tonight?"). "The answer comes from her own reminder schedule, with citations, and is read aloud in Telugu." |
| 3:20–3:40 | Language menu | "English plus 12 Indian languages: Hindi, Bengali, Marathi, Telugu, Tamil, Gujarati, Urdu, Kannada, Odia, Malayalam, Punjabi and Assamese, including right-to-left Urdu. Each family member keeps their own language for summaries, chat, voice and notifications." Switch to اردو for a second, then back. |
| 3:40–4:00 | Phone (notification) | Show a dose notification with *Taken* and *Snooze* buttons. "Push reminders in the person's language, from an always-on AWS free-tier server. AI reads and explains, code decides, and you stay in control." |

## If something goes wrong

- **Chat or translation fails with a quota error.** Say "the free-tier quota ran out". Insights, reminders and the
  copilot don't use the model at all, so they keep working in English; switch the language back to English.
- **The mic is blocked.** Type the question in Telugu instead (or tap a suggested question), then tap the speaker.
- **No notification arrives.** Check the browser's site settings allow notifications; on iPhone the site must be
  added to the Home Screen first. The in-app *Medicine due* card shows the same dose.
- **Backup video.** Record a run-through of this script with the same data beforehand.

## Upload, review and FHIR script

| Screen | Say / do |
|---|---|
| Upload | Drop `rx_bilingual_telugu.png`. "Phone photos and PDFs both work. The pipeline deskews and enhances the page, classifies it, extracts with Gemini vision into a strict schema, checks every value in code, then has a *different* model re-read the page." |
| Review | "The original sits next to every extracted field, with confidence and whether both reads agree." *Confirm & save*: "Nothing reaches the record until a person confirms it", and the copilot banner shows what it scheduled. |
| Trends | "Flags are computed by code from the report's own range, never by the AI. The shaded band is the reference range." |
| ABHA & Records | "Link an ABHA with OTP (demo OTP `123456`), grant consent, pull FHIR records from a hospital. Every document exports as an NRCeS-profile FHIR R4 bundle." |
